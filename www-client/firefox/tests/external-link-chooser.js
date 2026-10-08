#!/usr/bin/env node
'use strict';
/* Harness for the external-link chooser (the "Open link in..." window).
 *
 * Why this exists. 8ab07e5c made "all interfaces" selectable and renamed the
 * chooser's empty-valued dropdown row from "(profile default)" to "All
 * interfaces (no binding)" -- but an empty iface is NOT a bind-all: bindTab
 * no-ops on it, so the opened tab inherited the profile default, whatever
 * that was. The inheritance option disappeared behind a label that promised
 * something else, and nothing noticed because no harness read this window at
 * all. The restored list has both rows with distinct values:
 *
 *   interfaces...      value = the interface name (per-tab binding)
 *   All interfaces     value = '*'  (per-tab sentinel; ResolveForLoad
 *                                      translates it to empty in the TAB
 *                                      layer, so it routes unbound while
 *                                      overriding the profile default)
 *   Use profile default value = ''   (no per-tab binding; inherits)
 *
 * ...and the sentinel must never be WRITTEN as the profile default: the
 * profile layer has no '*' translation, so it would reach SO_BINDTODEVICE
 * verbatim and refuse every bind. The profile default's "all interfaces" is
 * the empty pref. That is asserted on all three surfaces: the chooser (what
 * it sends), the background (same-profile path) and the host (other-profile
 * path).
 *
 * Run:  node tests/external-link-chooser.js [<extension tree>] [<rozelynx-host>]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ok, eq, note, run } = require('./lib/check');
const { root, hostPath, requireTree } = require('./lib/roots');

const ROOT = requireTree(root(process.argv), 'extension tree');
const MOD = ['modules/external-link', 'extension/modules/external-link']
  .map(rel => path.join(ROOT, rel))
  .find(dir => fs.existsSync(dir));
if (!MOD) {
  console.error('FATAL: no modules/external-link under ' + ROOT +
    ' -- assemble with --enable external-link (the ebuild does, via USE=pwa)');
  process.exit(2);
}
const HOST = hostPath(process.argv);

/* ── a minimal DOM, only what choose.js touches ────────────────── */
class El {
  constructor() {
    this.children = [];
    this._listeners = {};
    this._text = '';
    this.value = '';
    this.checked = false;
    this.disabled = false;
    this.className = '';
    const self = this;
    this.classList = { toggle(name, on) {
      const set = new Set(String(self.className || '').split(/\s+/).filter(Boolean));
      if (on) set.add(name); else set.delete(name);
      self.className = Array.from(set).join(' ');
    } };
  }
  get textContent() {
    if (this.children.length) return this.children.map(c => c.textContent).join('');
    return this._text;
  }
  set textContent(v) { this._text = String(v); this.children = []; }
  set innerHTML(v) { if (v === '') this.children = []; }
  appendChild(child) { this.children.push(child); return child; }
  addEventListener(type, fn) { this._listeners[type] = fn; }
}

function fakeDoc() {
  const ids = {};
  ['url-display', 'profile-select', 'profile-hint', 'iface-select',
   'set-default', 'status', 'open-btn', 'picker-form'].forEach(id => {
    ids[id] = new El();
  });
  return { getElementById: id => ids[id] || null, createElement: () => new El(), _ids: ids };
}

/* Load choose.js verbatim into a vm and settle its load-time promises. */
async function loadChooser(opts) {
  const doc = fakeDoc();
  const sent = [];
  const sandbox = {
    document: doc,
    browser: {
      runtime: {
        sendMessage: m => {
          sent.push(m);
          if (m.action === 'external-link:profiles') {
            return Promise.resolve({ ok: true, data: { profiles: [], defaultDir: '', currentDir: '' } });
          }
          return Promise.resolve({ ok: true, data: { mode: 'tab', tabId: 1 } });
        },
      },
      rozelynxNetIface: {
        getInterfaces: () => Promise.resolve(opts.interfaces || []),
        // Synchronous in the real experiment API, and choose.js reads the
        // return value without awaiting it -- a stub that resolves a
        // promise here makes every interface compare against a Promise
        // object and the preselection silently lands on the fallback.
        getProfileInterface: () => (opts.profileDefault || ''),
      },
    },
    location: {
      search: '?url=' + encodeURIComponent(opts.url || 'https://example.com/') + '&current=cur',
    },
    URLSearchParams,
    window: { close() {} },
    setTimeout: () => 0,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(MOD, 'choose.js'), 'utf8'), sandbox);
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  return { doc, sent };
}

/* Load background.js verbatim; its onMessage listener is the entry point. */
let bgListener = null;
function makeBackgroundStub() {
  const calls = { assignments: [], profileSets: [], native: [] };
  const browser = {
    tabs: { create: () => Promise.resolve({ id: 7 }) },
    rozelynxNetIface: {
      setAssignment: (tabId, iface) => { calls.assignments.push([tabId, iface]); },
      setProfileInterface: iface => { calls.profileSets.push(iface); },
    },
    runtime: {
      sendNativeMessage: (host, msg) => { calls.native.push(msg); return Promise.resolve({ ok: true }); },
      onMessage: { addListener: fn => { bgListener = fn; } },
    },
  };
  return { browser, calls };
}

async function openViaBackground(calls, data) {
  const resp = await new Promise(resolve => {
    const ret = bgListener({ action: 'external-link:open', data }, {}, resolve);
    if (ret !== true) resolve({ ok: false, error: 'listener did not hold the channel' });
  });
  await new Promise(r => setImmediate(r));
  return resp;
}

/* ── the chooser list: composition, order, selection ───────────── */
async function chooserChecks() {
  const ifaces = [
    { name: 'wlan0', displayName: 'wlan0', type: 'wifi' },
    { name: 'eth0', displayName: 'eth0' },
  ];

  // Composition and order: interfaces, then the '*' bind-all, then the
  // inheritance row at the VERY bottom -- the same shape as the chip
  // picker, whose "(profile default)" row sits last too.
  {
    const { doc } = await loadChooser({ interfaces: ifaces, profileDefault: 'wlan0' });
    const opts = doc._ids['iface-select'].children;
    eq(opts.length, 4, 'chooser: two interfaces + bind-all + inherit = four options');
    eq(opts[0].value, 'wlan0', 'chooser: first option is the first interface');
    eq(opts[1].value, 'eth0', 'chooser: second option is the second interface');
    eq(opts[2].value, '*', 'chooser: the all-interfaces option carries the per-tab sentinel');
    eq(opts[2].textContent, 'All interfaces (no binding)', 'chooser: the bind-all label matches the chip picker');
    eq(opts[3].value, '', 'chooser: the inheritance option carries the empty value');
    eq(opts[3].textContent, 'Use profile default', 'chooser: the inheritance label names what it does');
    ok(opts.map(o => o.value).indexOf('') === opts.length - 1,
      'chooser: "Use profile default" sits at the very bottom of the list');
    ok(opts[0].selected && !opts[3].selected,
      'chooser: the profile default interface is preselected');
  }

  // An empty profile default preselects the inheritance row, not the sentinel.
  {
    const { doc } = await loadChooser({ interfaces: ifaces, profileDefault: '' });
    const opts = doc._ids['iface-select'].children;
    ok(!opts[2].selected, 'chooser: the sentinel is never preselected');
    ok(opts[3].selected, 'chooser: an empty profile default preselects "Use profile default"');
  }

  // A stale profile default (an interface the list does not carry) also falls
  // back to the inheritance row: inheriting is the safe default the old
  // "(profile default)" first row used to provide.
  {
    const { doc } = await loadChooser({ interfaces: ifaces, profileDefault: 'old0' });
    const opts = doc._ids['iface-select'].children;
    ok(opts[3].selected, 'chooser: a stale profile default preselects "Use profile default"');
  }

  // Submit: the sentinel passes through to the message as the tab binding.
  {
    const { doc, sent } = await loadChooser({ interfaces: ifaces, profileDefault: '' });
    const form = doc._ids['picker-form'];
    doc._ids['profile-select'].value = 'cur';
    doc._ids['iface-select'].value = '*';
    doc._ids['set-default'].checked = true;
    form._listeners.submit({ preventDefault() {} });
    const msg = sent.find(m => m.action === 'external-link:open');
    ok(msg, 'chooser: submit sends the open message');
    if (msg) {
      eq(msg.data.iface, '*', 'chooser: submit passes the sentinel through as the tab binding');
      eq(msg.data.setDefault, true, 'chooser: submit passes setDefault through');
    }
  }
}

/* ── background.js: the sentinel reaches the tab, never the pref ── */
async function backgroundChecks() {
  const stub = makeBackgroundStub();
  const sandbox = { browser: stub.browser, console, Promise };
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(MOD, 'background.js'), 'utf8'), sandbox);

  // Same profile, sentinel, setDefault: the TAB gets the raw '*' (a real
  // binding that routes unbound and overrides the profile default) while the
  // PROFILE default is written as the empty pref -- '*' has no translation in
  // the profile layer and would refuse every bind.
  {
    const resp = await openViaBackground(stub.calls, {
      url: 'https://example.com/', profile: 'cur', iface: '*', setDefault: true, current: 'cur',
    });
    ok(resp.ok, 'background: same-profile open succeeds');
    eq(stub.calls.assignments.length, 1, 'background: the sentinel binds the tab (one setAssignment)');
    eq(stub.calls.assignments[0] && stub.calls.assignments[0][1], '*',
      'background: setAssignment receives the raw sentinel');
    eq(stub.calls.profileSets[0], '', 'background: the profile default is written as the empty pref');
    const pref = stub.calls.native.filter(m => m.action === 'set-prefs')
      .map(m => m.prefs && m.prefs['rozelynx.netiface.profile'])[0];
    eq(pref, '', 'background: the persisted pref is empty, never "*"');
  }

  // Same profile, sentinel, no setDefault: binding only, no profile write.
  {
    stub.calls.assignments = []; stub.calls.profileSets = []; stub.calls.native = [];
    const resp = await openViaBackground(stub.calls, {
      url: 'https://example.com/', profile: 'cur', iface: '*', setDefault: false, current: 'cur',
    });
    ok(resp.ok, 'background: sentinel without setDefault succeeds');
    eq(stub.calls.assignments.length, 1, 'background: the tab is still bound');
    eq(stub.calls.profileSets.length, 0, 'background: no profile default write');
    eq(stub.calls.native.length, 0, 'background: no host round-trip');
  }

  // Same profile, real interface: passes through untouched both ways.
  {
    stub.calls.assignments = []; stub.calls.profileSets = []; stub.calls.native = [];
    const resp = await openViaBackground(stub.calls, {
      url: 'https://example.com/', profile: 'cur', iface: 'wlan0', setDefault: true, current: 'cur',
    });
    ok(resp.ok, 'background: real interface open succeeds');
    eq(stub.calls.assignments[0] && stub.calls.assignments[0][1], 'wlan0',
      'background: a real interface binds the tab verbatim');
    eq(stub.calls.profileSets[0], 'wlan0',
      'background: a real interface is written as the profile default verbatim');
  }

  // Same profile, inheritance (''): no tab binding at all.
  {
    stub.calls.assignments = []; stub.calls.profileSets = []; stub.calls.native = [];
    const resp = await openViaBackground(stub.calls, {
      url: 'https://example.com/', profile: 'cur', iface: '', setDefault: true, current: 'cur',
    });
    ok(resp.ok, 'background: inheritance open succeeds');
    eq(stub.calls.assignments.length, 0,
      'background: the inheritance value records NO tab binding');
    eq(stub.calls.profileSets[0], '',
      'background: the inheritance profile default is the empty pref');
  }

  // Another profile: the host receives the RAW sentinel (the launched browser
  // binds the tab with it) and must translate before persisting -- checked
  // against the host source below.
  {
    stub.calls.assignments = []; stub.calls.profileSets = []; stub.calls.native = [];
    const resp = await openViaBackground(stub.calls, {
      url: 'https://example.com/', profile: 'other', iface: '*', setDefault: true, current: 'cur',
    });
    ok(resp.ok, 'background: other-profile open succeeds');
    const msg = stub.calls.native.filter(m => m.action === 'open-rozelynx-profile')[0];
    ok(msg, 'background: the other-profile path goes through the host');
    if (msg) {
      eq(msg.iface, '*',
        'background: the host receives the raw sentinel for the tab binding');
      eq(msg.setDefault, true, 'background: setDefault travels to the host');
    }
  }
}

/* ── the host: the sentinel is translated before it is persisted ── */
function hostChecks() {
  if (!fs.existsSync(HOST)) {
    note('no rozelynx-host at ' + HOST + ' -- host source checks skipped');
    return;
  }
  const src = fs.readFileSync(HOST, 'utf8');
  ok(/profile_iface = '' if iface == '\*' else iface/.test(src),
    "host: '*' is translated to the empty pref before persisting");
  ok(/write_profile_pref\(profile_dir, 'rozelynx\.netiface\.profile',\s*\n\s*profile_iface\)/.test(src),
    'host: the profile default pref is written from the translated value');
  ok(/argv \+= \['--external-link-iface', iface\]/.test(src),
    'host: the raw iface (sentinel included) still reaches --external-link-iface');
  ok(!/write_profile_pref\([^)]*netiface\.profile',[^)]*\biface\)/.test(src),
    'host: no path persists the raw iface as the profile default');
}

async function main() {
  await chooserChecks();
  await backgroundChecks();
  hostChecks();
}
run('external-link-chooser', main);
