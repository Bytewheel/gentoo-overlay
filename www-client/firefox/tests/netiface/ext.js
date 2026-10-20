#!/usr/bin/env node
/* Verification harness for RozeLynx Part F on the extension side.
 *
 * Runs the REAL files, loaded verbatim into a vm context:
 *   lib/experiments/netiface-api.js  (the parent-side experiment API)
 *   modules/netiface/urlrules-ui.js  (the popup's rules editor)
 *   modules/netiface/background.js   (the netiface:refresh action)
 * plus a small fake DOM for the editor. Nothing is reimplemented.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const vm = require('vm');

// The source root (files/rozelynx) or an ASSEMBLED extension output root: the
// layout differs by one directory level, so probe for lib/experiments.
function resolveRoot(arg) {
  // argv, then RZ_TEST_ROOT, then this directory's own overlay tree. The
  // absolute path that used to be here made the harness read one specific
  // checkout no matter where it was run from - which is how the branding
  // harness came to test a stale copy of its subject and still report success.
  const base = arg || process.env.RZ_TEST_ROOT ||
    path.resolve(__dirname, '..', '..', 'files', 'rozelynx');
  if (fs.existsSync(path.join(base, 'extension/lib/experiments/netiface-api.js'))) {
    return base;
  }
  if (fs.existsSync(path.join(base, 'lib/experiments/netiface-api.js'))) {
    return base;  // assembled: same relative paths from here on
  }
  throw new Error('no netiface-api.js under ' + base);
}
const SRC = resolveRoot(process.argv[2]);
// Source tree: <root>/extension/{lib,modules}; assembled output: <root>/{lib,modules}
const EXT = fs.existsSync(path.join(SRC, 'extension', 'lib')) ? 'extension/' : '';

let pass = 0;
const failures = [];
function check(ok, what) {
  if (ok) { pass++; } else { failures.push(what); }
}
function eq(got, want, what) {
  check(got === want, `${what}: got ${JSON.stringify(got)} want ${JSON.stringify(want)}`);
}

// ── a minimal DOM, enough for the editor ──────────────────────────
class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.children = [];
    this.listeners = {};
    this.attrs = {};
    this.style = {};
    this._text = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.hidden = false;
    this.selected = false;
    this.className = '';
    const self = this;
    this.classList = {
      toggle(name, on) {
        const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
        if (on) set.add(name); else set.delete(name);
        self.className = Array.from(set).join(' ');
      },
    };
    this.spellcheck = true;
    this.type = '';
    this.title = '';
    this.parentNode = null;
  }
  get textContent() {
    if (this.children.length) { return this.children.map(c => c.textContent).join(''); }
    return this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  appendChild(child) { child.parentNode = this; this.children.push(child); return child; }
  append(...nodes) { nodes.forEach(n => this.appendChild(typeof n === 'string' ? textNode(n) : n)); }
  removeChild(child) { this.children = this.children.filter(c => c !== child); }
  setAttribute(k, v) { this.attrs[k] = String(v); }
  getAttribute(k) { return this.attrs[k]; }
  addEventListener(ev, fn) { (this.listeners[ev] = this.listeners[ev] || []).push(fn); }
  dispatch(ev, arg) { (this.listeners[ev] || []).forEach(fn => fn(arg || { preventDefault() {} })); }
  click() { this.dispatch('click'); }
  focus() { this.focused = true; }
  select() { this.selected = true; }
  querySelector() { return null; }
  // convenience for assertions
  find(pred, out = []) {
    if (pred(this)) out.push(this);
    this.children.forEach(c => c.find && c.find(pred, out));
    return out;
  }
  byId(id) { return this.find(e => e.attrs.id === id)[0] || null; }
  byClass(name) { return this.find(e => e.className === name); }
}
function textNode(s) { const e = new El('#text'); e.textContent = s; return e; }

function makeDom(ids) {
  const root = new El('body');
  root.getElementById = (id) => root.byId(id);
  root.createElement = (tag) => new El(tag);
  ids.forEach(id => {
    const el = new El(id.startsWith('urlrules-new') ? 'input' : 'div');
    el.setAttribute('id', id);
    root.appendChild(el);
  });
  // the real elements the editor expects
  const header = root.byId('urlrules-header');
  header.tagName = 'BUTTON';
  const master = root.byId('urlrules-enabled');
  master.tagName = 'INPUT';
  master.type = 'checkbox';
  root.byId('urlrules-new-pattern').tagName = 'INPUT';
  root.byId('urlrules-new-pattern').type = 'text';
  root.byId('urlrules-new-iface').tagName = 'SELECT';
  root.byId('urlrules-add-btn').tagName = 'BUTTON';
  root.byId('urlrules-add-current').tagName = 'BUTTON';
  const section = root.byId('urlrules-section');
  section.hidden = true;
  root.byId('urlrules-body').hidden = true;
  return root;
}

// ── Services.prefs stand-in ───────────────────────────────────────
function makePrefs(initial = {}) {
  const strs = new Map();
  const bools = new Map();
  Object.entries(initial).forEach(([k, v]) => {
    if (typeof v === 'boolean') bools.set(k, v); else strs.set(k, v);
  });
  const log = [];
  return {
    strs, bools, log,
    prefs: {
      getChildList(prefix) {
        return Array.from(strs.keys()).concat(Array.from(bools.keys()))
          .filter(k => k.startsWith(prefix)).sort();
      },
      getStringPref(name, dflt) { return strs.has(name) ? strs.get(name) : dflt; },
      getBoolPref(name, dflt) { return bools.has(name) ? bools.get(name) : dflt; },
      setStringPref(name, value) { strs.set(name, value); log.push(['str', name, value]); },
      setBoolPref(name, value) { bools.set(name, value); log.push(['bool', name, value]); },
      clearUserPref(name) { strs.delete(name); bools.delete(name); log.push(['clear', name]); },
    },
  };
}

// ── a stubbed native service (what nsIRozeLynxNetIface exposes) ───
function makeService(opts = {}) {
  const calls = [];
  const iface = (name) => ({ name, displayName: name, hasIPv4: true, hasIPv6: false });
  const svc = {
    calls,
    interfaces: [iface('wlan0'), iface('eth0'), iface('vpn0')],
    getProfileInterface: () => 'wlan0',
    getIfaceTrrURI: () => '',
    getEffective(browserId, userContextId, url, out) {
      calls.push(['getEffective', browserId, userContextId, url]);
      if (out) { out.value = opts.layer || 'url'; }
      return opts.iface === undefined ? 'wlan0' : opts.iface;
    },
    getInterfaces() { return Promise.resolve(svc.interfaces); },
    rules: opts.rules || [],
    matchUrlRule(url, out) {
      calls.push(['matchUrlRule', url]);
      const hit = (svc.rules || []).find(r => url.includes(r.pattern.replace('*.', '')));
      if (hit && out) {
        out.index = hit.index;
        out.pattern = hit.pattern;
        out.iface = hit.iface;
        return true;
      }
      return false;
    },
    setTabInterface() { return undefined; },
    setProfileInterface() { return undefined; },
  };
  return svc;
}

// ── the schema layer, modelled from Schemas.sys.mjs ───────────────
// Firefox validates experiment-API arguments against the schema JSON
// before the implementation runs, and this vm has no such layer - the
// stubs below called the implementation directly, which is why the
// schema could disagree with the code and no check noticed.
//
// The rule that matters here is ObjectType.normalize in
// Schemas.sys.mjs: for an object type, any property the schema does not
// declare produces "Unexpected property" and rejects the WHOLE call,
// unless the schema carries "additionalProperties". getUrlRules()
// returns records with an extra `index` field, so the contract the
// editor depends on is that a row may be echoed straight back into
// setUrlRules. The user-visible failure this guards: the first add
// works (the list was empty), and every later one died in validation
// with the echoed row's index field - one rule was the hard cap.
// ── the schema PARSER, modelled from RootType.parseSchema ────────
// The load-time half of the schema layer, which this harness had no
// model of at all: RootType.parseSchema resolves a schema object's
// "type" through the TYPES table - a schema with no "type", "$ref" or
// "choices" is TYPES[undefined], and `type.parseSchema(...)` on that
// THROWS, killing the whole extension as it loads. The 1.0.75
// regression was exactly that: setUrlRules gained
// "additionalProperties": {} (type-less), the normalize half of this
// harness accepted the key's mere presence, and the shipped extension
// died at load - no background page, so no chip (onShutdown had torn
// them down for the update), no context menu, no netiface at all.
// ObjectType.parseSchema accepts for additionalProperties: `true`
// (rewritten to {type:"any"}) or a schema with a resolvable type -
// the house form is { "type": "any" } (prefs-schema.json).
const SCHEMA_TYPES = new Set([
  'any', 'array', 'boolean', 'function', 'integer', 'null', 'number',
  'object', 'string',
]);
const TYPE_SCHEMA_MARKERS = [
  'type', '$ref', 'choices', 'enum', 'optional', 'items', 'properties',
  'additionalProperties', 'patternProperties', 'minItems', 'maxItems',
  'minLength', 'maxLength', 'pattern', 'format',
];

const SCHEMA_VALUED_KEYS = ['items', 'additionalProperties'];

function typeSchemaParses(value, path, errs) {
  // value IS a type schema by construction: it was reached through a
  // schema-valued position (items, additionalProperties, a properties
  // entry, a parameter entry), so there is no "does this look like a
  // schema" question to ask - the parser hands it straight to
  // RootType.parseSchema, and a type-less object (the shipped
  // "additionalProperties": {}) is TYPES[undefined], which throws and
  // fails the whole extension load.
  if (Array.isArray(value)) {
    value.forEach((v, i) => typeSchemaParses(v, `${path}[${i}]`, errs));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;  // e.g. "additionalProperties": true - the parser rewrites it.
  }
  if ('choices' in value) {
    typeSchemaParses(value.choices, `${path}.choices`, errs);
  } else if ('$ref' in value) {
    // Resolved against the namespace by RefType.
  } else if (!('type' in value)) {
    errs.push(`${path}: type schema with no "type", "$ref" or ` +
      `"choices" - RootType.parseSchema reads TYPES[undefined] and ` +
      `throws, which fails the whole extension load`);
  } else if (!SCHEMA_TYPES.has(value.type)) {
    errs.push(`${path}: unknown type "${value.type}"`);
  }
  for (const key of SCHEMA_VALUED_KEYS) {
    if (key in value) {
      typeSchemaParses(value[key], `${path}.${key}`, errs);
    }
  }
  for (const key of ['properties', 'patternProperties']) {
    // A name -> schema map: each VALUE is the schema, the map is not.
    if (key in value) {
      for (const [name, child] of Object.entries(value[key])) {
        typeSchemaParses(child, `${path}.${key}.${name}`, errs);
      }
    }
  }
  // Everything else (parameters, events, default values, ...) is
  // structural: walk it generically and let the marker heuristic there
  // decide what is a schema.
  for (const [key, child] of Object.entries(value)) {
    if (!SCHEMA_VALUED_KEYS.includes(key) &&
        key !== 'properties' && key !== 'patternProperties') {
      schemaParseErrors(child, `${path}.${key}`, errs);
    }
  }
}

function schemaParseErrors(value, path, errs) {
  if (Array.isArray(value)) {
    value.forEach((v, i) => schemaParseErrors(v, `${path}[${i}]`, errs));
    return;
  }
  if (typeof value !== 'object' || value === null) {
    return;
  }
  if (TYPE_SCHEMA_MARKERS.some(k => k in value)) {
    typeSchemaParses(value, path, errs);
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (SCHEMA_VALUED_KEYS.includes(key)) {
      typeSchemaParses(child, `${path}.${key}`, errs);
    } else if (key === 'properties' || key === 'patternProperties') {
      for (const [name, entry] of Object.entries(child)) {
        typeSchemaParses(entry, `${path}.${key}.${name}`, errs);
      }
    } else {
      schemaParseErrors(child, `${path}.${key}`, errs);
    }
  }
}

function extensionSchemasParse() {
  const errs = [];
  for (const f of fs.readdirSync(
      path.join(SRC, EXT, 'lib/experiments'))) {
    if (!f.endsWith('-schema.json')) {
      continue;
    }
    try {
      const schemas = JSON.parse(fs.readFileSync(
        path.join(SRC, EXT, 'lib/experiments', f), 'utf8'));
      schemaParseErrors(schemas, f, errs);
    } catch (e) {
      errs.push(`${f}: ${e.message}`);
    }
  }
  return errs;
}

let gSetUrlRulesItems = null;
function setUrlRulesItemSchema() {
  if (!gSetUrlRulesItems) {
    const schemas = JSON.parse(fs.readFileSync(
      path.join(SRC, EXT, 'lib/experiments/netiface-schema.json'), 'utf8'));
    const ns = schemas.find(e => e.namespace === 'rozelynxNetIface');
    const fn = ns.functions.find(f => f.name === 'setUrlRules');
    gSetUrlRulesItems = fn.parameters[0].items;
  }
  return gSetUrlRulesItems;
}

function schemaRejectsRow(row) {
  const items = setUrlRulesItemSchema();
  if (typeof row !== 'object' || row === null || Array.isArray(row)) {
    return 'Expected a plain JavaScript object';
  }
  const declared = new Set(Object.keys(items.properties || {}));
  for (const key of Object.keys(row)) {
    if (!declared.has(key) && !items.additionalProperties) {
      return `Unexpected property "${key}"`;
    }
  }
  for (const [key, type] of Object.entries(items.properties || {})) {
    if (key in row) {
      if (type.type === 'string' && typeof row[key] !== 'string') {
        return `Property "${key}" must be a string`;
      }
      if (type.type === 'boolean' && typeof row[key] !== 'boolean') {
        return `Property "${key}" must be a boolean`;
      }
    }
  }
  return null;
}

function schemaValidateSetUrlRules(rules) {
  if (!Array.isArray(rules)) {
    return 'Expected an array';
  }
  for (let i = 0; i < rules.length; i++) {
    const err = schemaRejectsRow(rules[i]);
    if (err) {
      return `${i}: ${err}`;
    }
  }
  return null;
}

// ── run the experiment API in a vm ────────────────────────────────
function loadApi({ prefs, service, tabs }) {
  const listeners = [];
  const src = fs.readFileSync(path.join(SRC, EXT + 'lib/experiments/netiface-api.js'), 'utf8');
  class ExtensionAPI { constructor() {} }
  class ExtensionAPIExtended {}
  const sandbox = {
    console,
    setTimeout, clearTimeout,
    URL, URLSearchParams, Map, Set, Promise, Object, JSON, String, Number, Array,
    ExtensionAPIPersistent: class { getAPI() { return {}; } },
    ExtensionAPI: class { getAPI() { return {}; } },
    ExtensionCommon: { EventManager: class { constructor() { this.api = () => () => {}; } } },
    // ChromeUtils models the real experiment-sandbox global: the sandbox is
    // built by ExtensionCommon.sys.mjs `_createExtGlobal`, which passes
    // `wantGlobalProperties: ["ChromeUtils"]` - i.e. the plain WebIDL
    // namespace, whose members are import/importESModule/defineESModuleGetters
    // and friends, and NO `Services`. `Services` is assigned to the same
    // sandbox as a global (right below), which is the only shape
    // netiface-api.js may read it in: a stub that also carries
    // ChromeUtils.Services would agree with the code under test and hide
    // exactly this bug again (the api did `const { Services } = ChromeUtils;`,
    // got `undefined`, and every Services.prefs call - the whole URL-rule
    // editor - threw with "can't access property 'prefs', Services is
    // undefined").
    ChromeUtils: {
      importESModule() {
        return {
          SessionStore: {
            getCustomTabValue: () => '',
            setCustomTabValue() {},
            deleteCustomTabValue() {},
          },
        };
      },
    },
    Ci: {},
    Cc: {
      '@bytewheel.org/netiface;1': {
        getService() {
          if (!service) { throw new Error('no service'); }
          return service;
        },
      },
    },
    Services: { prefs: prefs.prefs, wm: { getEnumerator: () => ({ hasMoreElements: () => false }) } },
  };
  sandbox.this = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  // The class assigns to `this.rozelynxNetIface`; run it and then call
  // getAPI() with a stub extension context.
  vm.runInContext(src, sandbox);
  const cls = sandbox.rozelynxNetIface || sandbox.globalThis.rozelynxNetIface;
  if (!cls) {
    throw new Error('the api class did not land on the sandbox: ' +
      Object.keys(sandbox).join(','));
  }
  const context = {
    extension: {
      tabManager: { get: (id) => tabs[id] },
      windowManager: { get: () => null },
    },
    menuItem: null,
  };
  // The framework instantiates the class and calls getAPI() on the
  // instance, so do exactly that.
  const api = new cls(context).getAPI(context);
  return api.rozelynxNetIface;
}

// ── run a module script in a vm against a fake DOM ────────────────
function loadScript(relPath, dom, browser) {
  const src = fs.readFileSync(path.join(SRC, relPath), 'utf8');
  const sandbox = {
    console,
    setTimeout, clearTimeout, Promise, Object, JSON, String, Number, Array, URL,
    document: dom,
    browser,
    location: { search: '' },
  };
  sandbox.window = sandbox;
  sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(src, sandbox, { filename: relPath });
  return sandbox;
}

function tick(n = 6) {
  let p = Promise.resolve();
  for (let i = 0; i < n; i++) {
    p = p.then(() => new Promise(r => setImmediate(r)));
  }
  return p;
}

// ──────────────────────────────────────────────────────────────────
// 1. the experiment API
// ──────────────────────────────────────────────────────────────────
async function testApi() {
  const tabs = {
    7: {
      url: 'https://sub.example.com/mail?x=1',
      nativeTab: {
        userContextId: 2,
        linkedBrowser: {
          browsingContext: { browserId: 99, top: { browserId: 99 } },
          currentURI: { spec: 'https://sub.example.com/mail?x=1' },
        },
      },
    },
    8: {
      // No ExtensionTab.url: the currentURI fallback must be used.
      nativeTab: {
        userContextId: 0,
        linkedBrowser: {
          browsingContext: { browserId: 100, top: { browserId: 100 } },
          currentURI: { spec: 'https://fallback.test/x' },
        },
      },
    },
    9: { nativeTab: null },
  };
  const service = makeService({ layer: 'url', iface: 'wlan0' });
  const prefs = makePrefs();
  const api = loadApi({ prefs, service, tabs });

  // getEffective must pass the tab URL as the service's third argument.
  const eff = api.getEffective(7);
  eq(eff.layer, 'url', 'getEffective reports the url layer');
  eq(eff.iface, 'wlan0', 'getEffective reports the interface');
  const ge = service.calls.find(c => c[0] === 'getEffective');
  eq(ge[3], 'https://sub.example.com/mail?x=1', 'getEffective passes the tab URL');
  eq(ge[1], 99, 'getEffective passes the browserId');
  eq(ge[2], 2, 'getEffective passes the userContextId');

  api.getEffective(8);
  const ge2 = service.calls.filter(c => c[0] === 'getEffective')[1];
  eq(ge2[3], 'https://fallback.test/x', 'getEffective falls back to currentURI');

  // An unknown tab must not reach the service.
  const before = service.calls.length;
  eq(JSON.stringify(api.getEffective(1234)), '{"iface":"","layer":""}',
    'getEffective on an unknown tab is empty');
  check(service.calls.length === before, 'getEffective skips the service for a dead tab');

  // getTabInfo carries the url now.
  const info = api.getTabInfo(7);
  eq(info.url, 'https://sub.example.com/mail?x=1', 'getTabInfo reports the url');

  // ── the rule list ──
  eq(JSON.stringify(api.getUrlRules()), '{"enabled":true,"rules":[]}',
    'an empty rule list');

  let res = api.setUrlRules([{ pattern: '*.example.com', iface: 'wlan0' }]);
  check(res.ok, 'setUrlRules ok');
  eq(res.rules.length, 1, 'one rule stored');
  eq(res.rules[0].pattern, '*.example.com', 'the pattern round-trips');
  eq(res.rules[0].index, 0, 'the index is 0');
  eq(prefs.strs.get('rozelynx.netiface.urlrule.0.pattern'), '*.example.com',
    'the pattern pref is written');
  eq(prefs.strs.get('rozelynx.netiface.urlrule.0.iface'), 'wlan0',
    'the iface pref is written');
  eq(prefs.bools.get('rozelynx.netiface.urlrule.0.enabled'), true,
    'enabled is written explicitly, not left absent');

  // An empty iface is meaningful, and must survive.
  api.setUrlRules([
    { pattern: 'a.test', iface: 'wlan0' },
    { pattern: 'b.test', iface: '' },
    { pattern: 'c.test', iface: 'vpn0', enabled: false },
  ]);
  const three = api.getUrlRules();
  eq(three.rules.length, 3, 'three rules stored');
  eq(three.rules[1].iface, '', 'an empty interface survives');
  eq(three.rules[2].enabled, false, 'a disabled rule survives');
  eq(prefs.bools.get('rozelynx.netiface.urlrule.2.enabled'), false,
    'a disabled rule writes enabled=false');

  // Deleting the tail must CLEAR the prefs, not leave live rules behind.
  api.setUrlRules([{ pattern: 'only.test', iface: 'wlan0' }]);
  check(!prefs.strs.has('rozelynx.netiface.urlrule.2.pattern'),
    'a deleted rule clears its pattern pref');
  check(!prefs.bools.has('rozelynx.netiface.urlrule.2.enabled'),
    'a deleted rule clears its enabled pref');
  check(!prefs.strs.has('rozelynx.netiface.urlrule.1.iface'),
    'a deleted middle rule clears its iface pref');
  eq(api.getUrlRules().rules.length, 1, 'one rule left after a shrink');

  // A blank pattern is refused, and nothing is written for it.
  res = api.setUrlRules([{ pattern: '   ', iface: 'wlan0' }]);
  check(!res.ok, 'a blank pattern is refused');
  check(/empty pattern/.test(res.error), 'the error names the problem');

  // A non-string iface must not become "[object Object]".
  api.setUrlRules([{ pattern: 'x.test', iface: 0 }]);
  eq(prefs.strs.get('rozelynx.netiface.urlrule.0.iface'), '0',
    'a numeric iface is stringified, not "[object Object]"');

  // The cap matches the native kMaxUrlRules.
  const many = [];
  for (let i = 0; i < 300; i++) many.push({ pattern: `h${i}.test`, iface: 'wlan0' });
  res = api.setUrlRules(many);
  check(!res.ok, 'over the cap is refused');
  check(/max 256/.test(res.error), 'the cap error names the limit');

  // Garbage in the prefs must not become a rule.
  const dirty = makePrefs({
    'rozelynx.netiface.urlrule.0.pattern': 'ok.test',
    'rozelynx.netiface.urlrule.0.iface': 'wlan0',
    'rozelynx.netiface.urlrule.x.iface': 'wlan0',
    'rozelynx.netiface.urlrule.x.pattern': 'bad-index.test',
    'rozelynx.netiface.urlrules.thing': 'x',
  });
  const api2 = loadApi({ prefs: dirty, service, tabs });
  const read = api2.getUrlRules();
  eq(read.rules.length, 1, 'a non-numeric index is not a rule');
  eq(read.rules[0].pattern, 'ok.test', 'the real rule is read');

  // The master switch.
  eq(api.setUrlRulesEnabled(false).enabled, false, 'the switch turns off');
  eq(prefs.bools.get('rozelynx.netiface.urlrules.enabled'), false,
    'the switch pref is written');
  eq(api.getUrlRules().enabled, false, 'the switch reads back');
  api.setUrlRulesEnabled(true);
  eq(api.getUrlRules().enabled, true, 'the switch turns back on');

  // matchUrlRule.
  service.rules = [{ index: 2, pattern: '*.example.com', iface: 'wlan0' }];
  const m = api.matchUrlRule('https://sub.example.com/x');
  check(m.matched, 'matchUrlRule reports a match');
  eq(m.index, 2, 'matchUrlRule reports the index');
  eq(m.pattern, '*.example.com', 'matchUrlRule reports the pattern');
  const no = api.matchUrlRule('https://other.test/');
  check(!no.matched, 'matchUrlRule reports no match');
  eq(no.index, -1, 'no match has index -1');

  // The chip's first paint must use the 3-argument service call too.
  // The chip's first paint calls the same service method with the same URL
  // argument (it lives inside the API, so the only observable is the call).
  service.calls.length = 0;
  api.getEffective(7);
  eq(service.calls[0][3], 'https://sub.example.com/mail?x=1',
    'the chip path uses the same URL argument');
}

// ──────────────────────────────────────────────────────────────────
// 2. the popup's rules editor
// ──────────────────────────────────────────────────────────────────
function editorBrowser({ service, prefs, store, tabs, noMessage }) {
  // The popup talks to the API through the schema layer, so the editor
  // legs get the same gate the real browser enforces - with it, a stub
  // that echoes rows through setUrlRules could never have agreed with a
  // schema that rejects them.
  const api = Object.assign({}, service, {
    setUrlRules(rules) {
      const err = schemaValidateSetUrlRules(rules);
      if (err) {
        return Promise.reject(
          new Error('Error processing setUrlRules.' + err));
      }
      return Promise.resolve(service.setUrlRules(rules));
    },
  });
  return {
    rozelynxNetIface: api,
    tabs: { query: () => Promise.resolve(tabs) },
    storage: {
      local: {
        get: (k) => Promise.resolve(store[k] === undefined ? {} : { [k]: store[k] }),
        set: (d) => { Object.assign(store, d); return Promise.resolve(); },
      },
    },
    runtime: {
      sendMessage: noMessage
        ? () => Promise.reject(new Error('no background'))
        : (m) => {
          service.messages = service.messages || [];
          service.messages.push(m);
          return Promise.resolve({ ok: true, data: true });
        },
    },
  };
}

async function testEditor() {
  // The pin: rows echoed straight back from getUrlRules() - index field
  // and all - must validate against the REAL schema, because the editor
  // clones what it renders. Pre-fix this was the whole bug: index made
  // every call after the first fail validation in the real browser,
  // and the vm had no schema layer to notice.
  const pinErr = schemaValidateSetUrlRules([
    { index: 0, pattern: '*.echoed.test', iface: 'wlan0', enabled: true },
    { pattern: 'fresh.test', iface: '', enabled: false },
  ]);
  check(pinErr === null,
    'the setUrlRules schema accepts a row echoed from getUrlRules()' +
    (pinErr ? ' (' + pinErr + ')' : ''));

  // The parser half: every schema file in the extension must survive
  // RootType.parseSchema. This is the check whose absence shipped
  // 1.0.75: a type-less "additionalProperties": {} killed the whole
  // extension at load, and the vm harness - which modelled only the
  // normalizer - reported 101 green.
  {
    const errs = extensionSchemasParse();
    check(errs.length === 0,
      'every experiment schema file parses like RootType.parseSchema' +
      (errs.length ? ' (' + errs.slice(0, 3).join('; ') + ')' : ''));
  }

  // The site button must live OUTSIDE the empty-state block in the real
  // markup: urlrules-empty is hidden as soon as any rule exists, and the
  // button used to vanish with it - unreachable exactly when it is most
  // wanted, with the manual row as the only way to add the second rule.
  {
    const html = fs.readFileSync(
      path.join(SRC, EXT, 'modules/qr-code/popup.html'), 'utf8');
    const emptyStart = html.indexOf('<div class="urlrules-empty"');
    const emptyEnd = html.indexOf('</div>', emptyStart);
    const btn = html.indexOf('id="urlrules-add-current"');
    check(emptyStart !== -1 && btn !== -1 && btn > emptyEnd,
      'the add-current button sits outside the empty-state block');
  }

  const service = makeService({ layer: 'url', iface: 'wlan0' });
  service.getEffective = () => Promise.resolve({ iface: 'wlan0', layer: 'url' });
  service.getUrlRules = () => Promise.resolve({
    enabled: true,
    rules: [
      { index: 0, pattern: '*.example.com', iface: 'wlan0', enabled: true },
      { index: 1, pattern: 'off.test', iface: '', enabled: false },
      { index: 2, pattern: 'vpn.test', iface: 'gone', enabled: true },
    ],
  });
  service.setUrlRules = (rules) => {
    service.written = rules;
    return Promise.resolve({ ok: true, enabled: true, rules });
  };
  service.setUrlRulesEnabled = (v) => Promise.resolve({ ok: true, enabled: v });

  const dom = makeDom(['urlrules-section', 'urlrules-header', 'urlrules-chevron',
    'urlrules-title', 'urlrules-count', 'urlrules-body', 'urlrules-enabled',
    'urlrules-preview', 'urlrules-list', 'urlrules-empty',
    'urlrules-add-current', 'urlrules-new-pattern', 'urlrules-new-iface',
    'urlrules-add-btn', 'urlrules-status']);
  const store = {};
  const browser = editorBrowser({
    service, prefs: makePrefs(), store,
    tabs: [{ id: 7, url: 'https://a.b.example.com/x' }],
  });
  loadScript(EXT + 'modules/netiface/urlrules-ui.js', dom, browser);
  await tick();

  const section = dom.byId('urlrules-section');
  check(!section.hidden, 'the section is revealed when the API is present');
  eq(dom.byId('urlrules-count').textContent, '3 rules', 'the count badge');
  const rows = dom.byId('urlrules-list').byClass('urlrules-row');
  eq(rows.length, 3, 'one row per rule');
  eq(dom.byId('urlrules-empty').hidden, true, 'the empty state is hidden');
  eq(dom.byId('urlrules-header').getAttribute('aria-expanded'), 'false',
    'collapsed by default');

  // Collapsed by default means the body is hidden and remembered.
  const body = dom.byId('urlrules-body');
  check(body.hidden, 'the body is hidden while collapsed');
  dom.byId('urlrules-header').dispatch('click');
  await tick();
  eq(dom.byId('urlrules-header').getAttribute('aria-expanded'), 'true',
    'the header expands on click');
  check(!body.hidden, 'the body is shown when expanded');
  eq(store.rozelynx_netiface_urlrules_expanded, true,
    'the expanded state is remembered in storage.local');

  // The match preview asks the service, for the active tab.
  await tick(10);
  const previewText = dom.byId('urlrules-preview').textContent;
  check(/a\.b\.example\.com/.test(previewText),
    'the preview names the current host: ' + previewText);
  check(/URL rule #/.test(previewText),
    'the preview names the winning rule: ' + previewText);

  // The interface <select> offers every interface, plus the default.
  const sel = rows[0].children[1];
  eq(sel.children.length, 4, '(default routing) + three interfaces');
  eq(sel.children[0].value, '', 'the first option is default routing');
  eq(sel.children[1].value, 'wlan0', 'the interfaces follow');
  // A rule naming an interface that is not up keeps its own option.
  const missing = rows[2].children[1];
  check(missing.children.some(o => o.value === 'gone' && /not available/.test(o.textContent)),
    'an unavailable interface is still shown');

  // Editing an interface writes the whole list.
  sel.value = 'vpn0';
  sel.dispatch('change');
  await tick();
  eq(service.written[0].iface, 'vpn0', 'an interface change is written');
  eq(service.written.length, 3, 'the whole list is written, not a delta');

  // Renaming a pattern.
  const pattern = rows[1].children[0];
  pattern.value = '  off2.test  ';
  pattern.dispatch('change');
  await tick();
  eq(service.written[1].pattern, 'off2.test', 'a pattern change is trimmed and written');

  // Emptying a pattern deletes the row instead of saving a dead rule.
  pattern.value = '   ';
  pattern.dispatch('change');
  await tick();
  eq(service.written.length, 2, 'an emptied pattern removes the row');
  check(!service.written.some(r => !r.pattern),
    'no empty pattern is ever written');

  // Deleting a row.
  rows[0].children[3].dispatch('click');
  await tick();
  eq(service.written.length, 1, 'delete writes the shortened list');

  // The enable checkbox.
  const enabled = dom.byId('urlrules-list').byClass('urlrules-row')[0].children[2];
  enabled.checked = false;
  enabled.dispatch('change');
  await tick();
  eq(service.written[0].enabled, false, 'unticking enable is written');

  // Adding a rule from the add row.
  dom.byId('urlrules-new-pattern').value = 'new.test';
  dom.byId('urlrules-new-iface').value = 'eth0';
  dom.byId('urlrules-add-btn').dispatch('click');
  await tick();
  const added = service.written[service.written.length - 1];
  eq(added.pattern, 'new.test', 'the add row appends a rule');
  eq(added.iface, 'eth0', 'the add row uses the chosen interface');

  // Enter in the pattern field is the same as Add.
  dom.byId('urlrules-new-pattern').value = 'enter.test';
  dom.byId('urlrules-new-pattern').dispatch('keydown', { key: 'Enter', preventDefault() {} });
  await tick();
  eq(service.written[service.written.length - 1].pattern, 'enter.test',
    'Enter adds the rule');

  // "Add a rule for this site" prefills the subdomain wildcard.
  dom.byId('urlrules-add-current').dispatch('click');
  await tick();
  eq(dom.byId('urlrules-new-pattern').value, '*.example.com',
    'the site button prefills a subdomain wildcard');

  // The master switch.
  const master = dom.byId('urlrules-enabled');
  eq(master.checked, true, 'the master switch reflects the stored state');
  master.checked = false;
  master.dispatch('change');
  await tick();
  eq(master.checked, false, 'the switch is written through the API');

  // Every write asks the background to repaint the chips.
  check((service.messages || []).every(m => m.action === 'netiface:refresh'),
    'writes send netiface:refresh');

  // A dead background must not break the editor.
  const dom2 = makeDom(['urlrules-section', 'urlrules-header', 'urlrules-chevron',
    'urlrules-title', 'urlrules-count', 'urlrules-body', 'urlrules-enabled',
    'urlrules-preview', 'urlrules-list', 'urlrules-empty',
    'urlrules-add-current', 'urlrules-new-pattern', 'urlrules-new-iface',
    'urlrules-add-btn', 'urlrules-status']);
  const svc2 = makeService({ layer: 'url' });
  svc2.getEffective = () => Promise.resolve({ iface: 'wlan0', layer: 'url' });
  svc2.getUrlRules = () => Promise.resolve({ enabled: true, rules: [] });
  // Echo like the REAL implementation does: the re-read records carry
  // an index field (readUrlRules builds {index, pattern, iface,
  // enabled}), which is what the editor clones on the next write.
  svc2.setUrlRules = (rules) => {
    svc2.written = rules;
    return Promise.resolve({
      ok: true, enabled: true,
      rules: rules.map((r, i) => Object.assign({ index: i }, r)),
    });
  };
  loadScript(EXT + 'modules/netiface/urlrules-ui.js', dom2,
    editorBrowser({ service: svc2, prefs: makePrefs(), store: {},
      tabs: [{ id: 7, url: 'https://a.test/' }], noMessage: true }));
  await tick();
  check(!dom2.byId('urlrules-section').hidden, 'the section still loads');
  eq(dom2.byId('urlrules-empty').hidden, false,
    'the empty state shows with no rules');
  dom2.byId('urlrules-new-pattern').value = 'z.test';
  dom2.byId('urlrules-add-btn').dispatch('click');
  await tick();
  eq(svc2.written ? svc2.written.length : 1, 1,
    'a rejected netiface:refresh does not fail the write');
  eq(dom2.byId('urlrules-status').textContent, '', 'no error is shown');
  eq(dom2.byId('urlrules-empty').hidden, true,
    'the empty state disappears once a rule is added');

  // THE one-rule trap: the second add clones the row that came back from
  // the first write. Pre-fix the clone carried the echoed index field
  // and the schema gate (above) rejected the whole call - the input
  // cleared, nothing was written, and the status stayed empty because
  // the editor cleared it before writing.
  dom2.byId('urlrules-new-pattern').value = 'second.test';
  dom2.byId('urlrules-add-btn').dispatch('click');
  await tick();
  eq(svc2.written.length, 2,
    'the SECOND add lands: ' + (dom2.byId('urlrules-status').textContent ||
      'no error'));
  eq(svc2.written[1].pattern, 'second.test', 'the second row is the new rule');
  check(svc2.written.every(r => !('index' in r)),
    'rows written back never carry the echoed index field');
  eq(dom2.byId('urlrules-status').textContent, '',
    'the second add shows no error');
  // The site button stays reachable with rules present: it used to live
  // inside the empty-state block, which hides as soon as a rule exists.
  dom2.byId('urlrules-add-current').dispatch('click');
  await tick();
  eq(dom2.byId('urlrules-new-pattern').value, 'a.test',
    'the site button still prefills with rules present (bare 2-label host)');

  // A build with no netiface API at all: the section stays hidden.
  const dom3 = makeDom(['urlrules-section', 'urlrules-header', 'urlrules-chevron',
    'urlrules-title', 'urlrules-count', 'urlrules-body', 'urlrules-enabled',
    'urlrules-preview', 'urlrules-list', 'urlrules-empty',
    'urlrules-add-current', 'urlrules-new-pattern', 'urlrules-new-iface',
    'urlrules-add-btn', 'urlrules-status']);
  const browser3 = editorBrowser({ service: makeService(), prefs: makePrefs(),
    store: {}, tabs: [{ id: 7, url: 'https://a.test/' }] });
  delete browser3.rozelynxNetIface;
  loadScript(EXT + 'modules/netiface/urlrules-ui.js', dom3, browser3);
  await tick();
  check(dom3.byId('urlrules-section').hidden,
    'the section stays hidden with no netiface API');

  // An older extension whose parent API has no rule functions: same outcome.
  const dom4 = makeDom(['urlrules-section', 'urlrules-header', 'urlrules-chevron',
    'urlrules-title', 'urlrules-count', 'urlrules-body', 'urlrules-enabled',
    'urlrules-preview', 'urlrules-list', 'urlrules-empty',
    'urlrules-add-current', 'urlrules-new-pattern', 'urlrules-new-iface',
    'urlrules-add-btn', 'urlrules-status']);
  const partial = { getUrlRules: () => Promise.resolve({}) };
  const b4 = editorBrowser({ service: partial, prefs: makePrefs(), store: {},
    tabs: [{ id: 7, url: 'https://a.test/' }] });
  loadScript(EXT + 'modules/netiface/urlrules-ui.js', dom4, b4);
  await tick();
  check(dom4.byId('urlrules-section').hidden,
    'the section stays hidden without matchUrlRule/setUrlRules');
}

// ──────────────────────────────────────────────────────────────────
// 3. the module's netiface:refresh action
// ──────────────────────────────────────────────────────────────────
async function testBackground() {
  const listeners = [];
  const wins = [{ id: 1, type: 'normal' }, { id: 2, type: 'normal' },
    { id: 3, type: 'popup' }];
  const chips = {};
  const updates = [];
  const browser = {
    runtime: { onMessage: { addListener: (fn) => listeners.push(fn) },
      onStartup: { addListener() {} }, lastError: null },
    contextMenus: { create() {}, update() { return Promise.resolve(); },
      onClicked: { addListener() {} }, onShown: { addListener() {} }, refresh() {} },
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(),
      remove: () => Promise.resolve() } },
    windows: { getAll: () => Promise.resolve(wins), create: () => Promise.resolve({ id: 9 }),
      remove: () => Promise.resolve(), onRemoved: { addListener() {}, removeListener() {} },
      onCreated: { addListener() {} }, get: () => Promise.resolve({ id: 1 }) },
    tabs: { query: (q) => Promise.resolve([{ id: 5, windowId: q.windowId || 1 }]),
      get: (id) => Promise.resolve({ id, windowId: 1, url: 'https://a.test/' }),
      onActivated: { addListener() {} }, onUpdated: { addListener() {} },
      onCreated: { addListener() {} }, onReplaced: { addListener() {} } },
    rozelynxNetIface: {
      getInterfaces: () => Promise.resolve([{ name: 'wlan0', hasIPv4: true }]),
      getEffective: () => Promise.resolve({ iface: 'wlan0', layer: 'url' }),
      getProfileInterface: () => Promise.resolve('wlan0'),
      setAssignment: () => Promise.resolve(true),
      getTabInfo: () => Promise.resolve({ browserId: 1, userContextId: 0 }),
      onChipClick: { addListener() {} },
      ensureChip: (id) => { chips[id] = true; return Promise.resolve({ ok: true }); },
      updateChip: (id, text, tooltip) => { updates.push([id, text, tooltip]); return Promise.resolve({ ok: true }); },
    },
  };
  loadScript(EXT + 'modules/netiface/background.js', new El('div'), browser);
  await tick(10);
  check(listeners.length === 1, 'the module registers one message listener');

  function send(message, expectHandled = true) {
    return new Promise((resolve) => {
      const r = listeners[0](message, { tab: { id: 5, windowId: 1 } }, resolve);
      if (expectHandled) {
        check(r === true, `${message.action} answers asynchronously`);
      } else {
        // Returning false is how the listener declines: the extension's other
        // modules must get the message instead.
        check(r === false, `${message.action} is declined, not answered`);
        resolve(undefined);
      }
    });
  }

  updates.length = 0;
  let res = await send({ action: 'netiface:refresh' });
  check(res.ok, 'netiface:refresh succeeds');
  eq(res.data, true, 'netiface:refresh reports it repainted');
  const touched = updates.map(u => u[0]).sort();
  eq(JSON.stringify(touched), '[1,2]', 'only normal windows were repainted');
  check(updates.every(u => /URL rule/.test(u[2])),
    'the chip tooltip explains the url layer: ' + (updates[0] || [])[2]);

  res = await send({ action: 'netiface:available' });
  eq(res.data.available, true, 'netiface:available is true with the API');

  res = await send({ action: 'netiface:effective', data: { tabId: 5 } });
  check(res.ok, 'netiface:effective still answers');
  eq(res.data.layer, 'url', 'the effective layer comes back');

  res = await send({ action: 'pwa:launch' }, false);
  eq(res, undefined, 'an unrelated message is not answered (no reply, listener returned false)');
}

// ──────────────────────────────────────────────────────────────────
// 4. a restored tab rebinds on activation, with no navigation
//
// The reported symptom was that restored tabs did not necessarily come back on
// their interface. The cause was an ordering gap in the triggers, not in the
// binding logic: rebindTab ran on tabs.onCreated, on tabs.onUpdated (guarded on
// changeInfo.status === 'complete'), onReplaced, and once ~2s after
// onStartup. Session restore does not navigate background tabs - collapsed tab
// groups are restored with no load at all - so such a tab fires none of those,
// and the one timed catch-up had long since passed. onActivated was the one
// event a restored tab always produces, and it refreshed the chip without ever
// rebinding.
//
// These checks drive the real listeners, so they fail if the handler is removed
// again. The idempotence case matters as much as the rebind: activation is
// frequent, and a handler that re-stamped every activation would be a
// performance problem of our own making.
// ──────────────────────────────────────────────────────────────────
async function testRestoreOnActivate() {
  const listeners = {};
  const assignments = [];
  let effective = { iface: 'wlan0', layer: 'profile' };
  const browser = {
    runtime: { onMessage: { addListener() {} }, onStartup: { addListener() {} },
      lastError: null },
    contextMenus: { create() {}, update: () => Promise.resolve(),
      onClicked: { addListener() {} }, onShown: { addListener() {} }, refresh() {} },
    storage: { local: { get: () => Promise.resolve({}), set: () => Promise.resolve(),
      remove: () => Promise.resolve() } },
    windows: { getAll: () => Promise.resolve([{ id: 1, type: 'normal' }]),
      create: () => Promise.resolve({ id: 9 }), remove: () => Promise.resolve(),
      onRemoved: { addListener() {}, removeListener() {} },
      onCreated: { addListener() {} }, get: () => Promise.resolve({ id: 1 }) },
    tabs: {
      query: () => Promise.resolve([{ id: 41, windowId: 1 }]),
      get: (id) => Promise.resolve({ id, windowId: 1, url: 'https://restored.test/' }),
      onActivated: { addListener: (fn) => { listeners.onActivated = fn; } },
      onUpdated: { addListener() {} },
      onCreated: { addListener() {} },
      onReplaced: { addListener() {} },
    },
    rozelynxNetIface: {
      getInterfaces: () => Promise.resolve([{ name: 'router', hasIPv4: true }]),
      // Starts on the WRONG interface, as a lazily-restored tab would be: the
      // sessionstore value says router, but nothing has re-applied it yet.
      getEffective: () => Promise.resolve(effective),
      getProfileInterface: () => Promise.resolve('wlan0'),
      setAssignment: (tabId, iface) => {
        assignments.push([tabId, iface]);
        effective = { iface, layer: 'tab' };
        return Promise.resolve(true);
      },
      // A restored tab: the interface lives in the sessionstore tab value.
      getTabInfo: () => Promise.resolve({ browserId: 7, userContextId: 0,
        tabValue: 'router' }),
      onChipClick: { addListener() {} },
      ensureChip: () => Promise.resolve({ ok: true }),
      updateChip: () => Promise.resolve({ ok: true }),
    },
  };
  loadScript(EXT + 'modules/netiface/background.js', new El('div'), browser);
  await tick(10);

  check(typeof listeners.onActivated === 'function',
    'the module listens for tabs.onActivated');

  // The module rebinds every tab once at init (background.js calls
  // rebindAllTabs() from its startup chain, not from the onStartup listener),
  // and again ~2s later. Both passes have therefore already run by the time
  // this test fires, and they would have consumed the assignment. Reset the
  // world to the state a LAZILY restored tab is actually in - present, carrying
  // its sessionstore interface, not bound - which is the only state in which
  // activation can be shown to matter. Without this reset the first version of
  // this test passed with the fix reverted, because it was measuring the init
  // pass and attributing it to activation.
  assignments.length = 0;
  effective = { iface: 'wlan0', layer: 'profile' };

  await listeners.onActivated({ tabId: 41, windowId: 1 });
  await tick(10);
  eq(JSON.stringify(assignments), '[[41,"router"]]',
    'activating a restored tab rebinds it to its sessionstore interface');

  // Second activation, now already correct: must not re-stamp.
  await listeners.onActivated({ tabId: 41, windowId: 1 });
  await tick(10);
  eq(assignments.length, 1,
    'activating again does not re-assign an already-correct binding');
}

// ──────────────────────────────────────────────────────────────────
(async function main() {
  const step = async (name, fn) => {
    process.stdout.write(`-- ${name}\n`);
    await fn();
  };
  await step('testApi', testApi);
  await step('testEditor', testEditor);
  await step('testBackground', testBackground);
  await step('testRestoreOnActivate', testRestoreOnActivate);
  failures.forEach(f => console.log('  FAIL  ' + f));
  console.log(`${pass} checks passed, ${failures.length} failed`);
  process.exit(failures.length ? 1 : 0);
})();
