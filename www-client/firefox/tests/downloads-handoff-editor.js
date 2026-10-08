/* The download hand-off handler editor, and the content script's link hook.
 *
 * D.7. Both real files - modules/downloads-handoff/handlers-ui.js and
 * content.js - are loaded VERBATIM into vm contexts. The editor is driven
 * through a small fake DOM built from the ids and classes the real
 * popup.html actually declares, so a typo in either file shows up here rather
 * than in a browser.
 *
 * Section 11 is the one that matters most: it runs the real editor and the
 * real background in ONE sandbox, routing the editor's messages into the
 * background's own onMessage listener. Sections 1-10 drive the editor with a
 * hand-written reply, which cannot see a bug in the background's availability
 * reporting - a mutation that made every handler report available passed all
 * 95 of them. That is why section 11 exists.
 *
 * Run:  node tests/downloads-handoff-editor.js [<extension root>]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ok, eq, run, tick } = require('./lib/check');
const { makeEnv: makeDomEnv, El } = require('./lib/fakedom');
const { root, requireTree } = require('./lib/roots');

const ROOT = requireTree(root(process.argv), 'extension tree');
const DIR = path.join(ROOT, 'modules/downloads-handoff');
const POPUP_HTML = path.join(ROOT, 'modules/qr-code/popup.html');
if (!fs.existsSync(path.join(DIR, 'handlers-ui.js'))) {
  console.error('FATAL: no downloads-handoff/handlers-ui.js under ' + ROOT);
  process.exit(2);
}

// ── the fake DOM the editor is rendered into ───────────────────────
// A tiny element with the handful of properties handlers-ui.js touches, built
// from the ids and classes the real popup.html declares so a typo in either
// file shows up here rather than in a browser.
function makeUi(opts) {
  opts = opts || {};
  const html = fs.readFileSync(POPUP_HTML, 'utf8');
  const ids = {};
  const re = /id="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    if (!(m[1] in ids)) ids[m[1]] = mkEl('div', m[1]);
  }
  ['handoff-section', 'handoff-body', 'handoff-empty'].forEach(id => {
    if (ids[id]) ids[id].hidden = true;
  });
  const byId = id => ids[id] || (ids[id] = mkEl('div', id));

  function mkEl(tag, id) {
    const el = new El(tag || 'div');
    el.id = id;
    el.hidden = false;
    el.disabled = false;
    el.value = '';
    el.checked = false;
    el._text = '';
    Object.defineProperty(el, 'textContent', {
      get() { return el.children.length ? el.children.map(c => c.textContent).join('') : el._text; },
      set(v) { el._text = String(v); el.children.length = 0; },
      configurable: true,
    });
    Object.defineProperty(el, 'options', {
      get() { return el.children.filter(c => c.tagName === 'OPTION'); },
      configurable: true,
    });
    return el;
  }

  // a <select> is not a real element in the fake DOM, so give the one the
  // editor writes to a value setter that behaves like one
  const sent = [];
  const nativeCalls = [];
  const calls = { downloads: [] };
  const bgPrefs = Object.assign({}, opts.prefs || {});
  const bg = { listener: null };
  const PREF_ACTIONS = {
    'downloads-handoff:handlers': 1, 'downloads-handoff:status': 1,
    'downloads-handoff:set-handlers': 1, 'downloads-handoff:set-enabled': 1,
    'downloads-handoff:probe': 1, 'downloads-handoff:intercept': 1,
  };
  const browser = {
    runtime: {
      sendMessage: function (msg) {
        sent.push(msg);
        if (opts.live) {
          // Straight into the real background's own onMessage listener, with the
          // same contract the browser enforces: `true` means it will answer
          // later, anything else means the channel closes and we reject.
          if (!bg.listener || !PREF_ACTIONS[msg && msg.action]) {
            return Promise.reject(new Error('Could not establish connection.'));
          }
          return new Promise((resolve, reject) => {
            let settled = false;
            const keep = bg.listener(msg, {}, (r) => { settled = true; resolve(r); });
            if (keep !== true && !settled) {
              reject(new Error('Could not establish connection.'));
            }
          });
        }
        const r = (opts.replies || {})[msg.action];
        if (r === undefined) return Promise.reject(new Error('Could not establish connection.'));
        if (typeof r === 'function') return Promise.resolve(r(msg));
        return Promise.resolve(r);
      },
      sendNativeMessage: function (host, m) {
        nativeCalls.push({ host: host, action: m.action, msg: m });
        if (m.action === 'handoff-probe') {
          return (opts.onPath || []).indexOf(m.program) >= 0
            ? Promise.resolve({ ok: true, program: m.program, path: '/usr/bin/' + m.program })
            : Promise.resolve({ ok: false, error: m.program + ' not found on PATH' });
        }
        if (m.action === 'uget-probe') {
          return (opts.uget || false)
            ? Promise.resolve({ ok: true, integrator: 'uget-integrator', uget: '2.2.3' })
            : Promise.resolve({ ok: false, error: 'uget-integrator not found on PATH' });
        }
        return Promise.resolve({ ok: true, pid: 1 });
      },
      getManifest: () => ({ version: '1.0.55' }),
      onMessage: { addListener: fn => { bg.listener = fn; } },
    },
    storage: { local: { get: () => Promise.resolve(opts.stored || {}), set: () => Promise.resolve() },
               onChanged: { addListener() {} } },
    downloads: { onCreated: { _list: [], addListener(fn) { this._list.push(fn); } },
                 // Resolves a BOOLEAN, as the real API does. It resolved
                 // undefined here, and the module now requires `=== true`
                 // before handing off (a cancel that is not a cancel must not
                 // produce a second copy of the file), so an undefined-resolving
                 // stub silently disabled every hand-off in this harness - which
                 // is 11.16 failing for a reason that had nothing to do with the
                 // editor. The stub has to model the contract, not a shape that
                 // happens to pass.
                 cancel: id => { calls.downloads.push(['cancel', id]); return Promise.resolve(true); },
                 erase: () => Promise.resolve(),
                 download: a => { calls.downloads.push(['download', a.url]); return Promise.resolve(1); } },
    cookies: { getAll: () => Promise.resolve([]) },
    management: { get: id => (opts.installed || {})[id]
        ? Promise.resolve(Object.assign({ id: id }, (opts.installed || {})[id]))
        : Promise.reject(new Error('No add-on with id ' + id)),
      onInstalled: { addListener() {} }, onEnabled: { addListener() {} },
      onDisabled: { addListener() {} }, onUninstalled: { addListener() {} } },
    contextMenus: { create() {}, removeAll: () => Promise.resolve(), onClicked: { addListener() {} } },
    rozelynxPrefs: {
      getPrefs: names => Promise.resolve((names || []).map(n => {
        if (!(n in bgPrefs)) return { name: n, type: 'missing', value: null };
        const v = bgPrefs[n];
        if (typeof v === 'boolean') return { name: n, type: 'boolean', value: v };
        if (typeof v === 'number') return { name: n, type: 'integer', value: v };
        return { name: n, type: 'string', value: String(v) };
      })),
      setPrefs: map => { Object.assign(bgPrefs, map); return Promise.resolve({ ok: true, written: 0, error: '' }); },
      clearPrefs: names => { (names || []).forEach(n => { delete bgPrefs[n]; }); return Promise.resolve({ ok: true, cleared: 0, error: '' }); },
    },
  };

  const doc = {
    getElementById: id => (id in ids ? ids[id] : null),
    createElement: tag => mkEl(tag),
    body: mkEl('body'),
  };
  const sandbox = {
    browser, document: doc, console: { log() {}, debug() {}, warn() {}, error() {} },
    Object, Array, String, Number, Boolean, RegExp, Error, JSON, Promise, Date, Math, Set,
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  sandbox.navigator = { userAgent: 'UA/1.0' };
  sandbox.setTimeout = (fn, ms) => setTimeout(fn, ms);
  sandbox.clearTimeout = t => clearTimeout(t);
  sandbox.fetch = () => Promise.reject(new Error('no network'));
  vm.createContext(sandbox);
  if (opts.live) {
    // The background FIRST: it registers the onMessage listener the editor
    // will then talk to.
    vm.runInContext(fs.readFileSync(path.join(DIR, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });
  }
  vm.runInContext(fs.readFileSync(path.join(DIR, 'handlers-ui.js'), 'utf8'), sandbox, { filename: 'handlers-ui.js' });

  return { ids, byId, sent, sandbox, mkEl, nativeCalls, bgPrefs, calls };
}

function rowsOf(ui) {
  return ui.ids['handoff-list'].children.filter(c => c.classList.contains('handoff-row'));
}
function notesOf(ui) {
  return ui.ids['handoff-list'].children.filter(c => c.classList.contains('handoff-note'));
}

const HANDLERS = [
  { index: 0, id: 'uget', kind: 'builtin', label: 'uGet', hint: 'built in', builtin: 'uget', extId: null, program: null, args: '', enabled: true, available: true, detail: 'uget-integrator 2.2.3' },
  { index: 1, id: 'cmd:aria2c', kind: 'cmd', label: 'aria2c', hint: 'a program on PATH', builtin: null, extId: null, program: 'aria2c', args: '-x 4 {url}', enabled: true, available: true, detail: '/usr/bin/aria2c' },
  { index: 2, id: 'ext:dl@x', kind: 'ext', label: 'dl@x', hint: 'another extension', builtin: null, extId: 'dl@x', program: null, args: '', enabled: false, available: false, detail: 'not installed or not enabled' },
];
const STATE = { ok: true, enabled: true, mode: 'auto', minSize: 307200, maxHandlers: 16, handlers: HANDLERS, availableCount: 2, bypassed: [], history: [] };

async function main() {

// ═══════════════════════════════════════════ 1. reveal + shape
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: true, ...STATE }, 'downloads-handoff:set-enabled': { ok: true, ...STATE } } });
  ok(ui.ids['handoff-section'].hidden === true, '1.1 the section starts hidden');
  await tick(); await tick();
  ok(ui.ids['handoff-section'].hidden === false, '1.2 and is revealed once the module answered');
  eq(rowsOf(ui).length, 3, '1.3 one row per handler');
  eq(ui.ids['handoff-count'].textContent, '3 handlers', '1.4 the count badge');
}
{
  // a build without the module: the message rejects, the section stays hidden
  const ui = makeUi({ replies: {} });
  await tick(); await tick();
  ok(ui.ids['handoff-section'].hidden === true, '1.5 no module -> the section stays hidden');
  eq(rowsOf(ui).length, 0, '1.6 and renders nothing');
}
{
  // a rejected read must not un-hide it either
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': { ok: false, error: 'nope' } } });
  await tick(); await tick();
  ok(ui.ids['handoff-section'].hidden === true, '1.7 a rejected read leaves it hidden');
}

// ═══════════════════════════════════════════ 2. rows
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE } });
  await tick(); await tick();
  const rows = rowsOf(ui);
  eq(rows.map(r => r.children[0].value), ['uget', 'cmd:aria2c', 'ext:dl@x'], '2.1 the id column');
  eq(rows.map(r => r.children[1].value), ['', '-x 4 {url}', ''], '2.2 the args column');
  eq(rows.map(r => r.children[1].disabled), [true, false, true], '2.3 args are editable only for a cmd: handler');
  eq(rows.map(r => r.children[2].checked), [true, true, false], '2.4 the enabled checkbox');
  eq(notesOf(ui).map(n => n.textContent), [
    '1. built in · uget-integrator 2.2.3',
    '2. program · /usr/bin/aria2c',
    '3. extension · disabled · not installed or not enabled',
  ], '2.5 the note line says the kind, the position and whether it can take a download');
  ok(notesOf(ui)[2].classList.contains('off'), '2.6 an unavailable handler is marked');
  ok(!notesOf(ui)[0].classList.contains('off'), '2.7 and an available one is not');
}

// ═══════════════════════════════════════════ 3. edits
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: true, ...STATE } } });
  await tick(); await tick();
  const idInput = rowsOf(ui)[1].children[0];
  idInput.value = 'cmd:wget';
  idInput.dispatch('change', {});
  await tick();
  const msg = ui.sent.filter(m => m.action === 'downloads-handoff:set-handlers').pop();
  ok(!!msg, '3.1 editing the id writes the whole list');
  eq(msg.handlers[1].id, 'cmd:wget', '3.2 with the new id');
  eq(msg.handlers.length, 3, '3.3 and the other rows are carried along');
  eq(msg.handlers[0].id, 'uget', '3.4 unchanged');
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: true, ...STATE } } });
  await tick(); await tick();
  const cb = rowsOf(ui)[2].children[2];
  cb.checked = true;
  cb.dispatch('change', {});
  await tick();
  const msg = ui.sent.filter(m => m.action === 'downloads-handoff:set-handlers').pop();
  eq(msg.handlers[2].enabled, true, '3.5 the enabled checkbox writes enabled');
  eq(msg.handlers[2].id, 'ext:dl@x', '3.6 without disturbing the id');
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: true, ...STATE } } });
  await tick(); await tick();
  const args = rowsOf(ui)[1].children[1];
  args.value = '-j 8 {url}';
  args.dispatch('change', {});
  await tick();
  const msg = ui.sent.filter(m => m.action === 'downloads-handoff:set-handlers').pop();
  eq(msg.handlers[1].args, '-j 8 {url}', '3.7 the args template is written');
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: true, ...STATE } } });
  await tick(); await tick();
  rowsOf(ui)[0].children[3].dispatch('click', { preventDefault() {} });
  await tick();
  const msg = ui.sent.filter(m => m.action === 'downloads-handoff:set-handlers').pop();
  eq(msg.handlers.map(h => h.id), ['cmd:aria2c', 'ext:dl@x'], '3.8 delete removes that row and reindexes');
}

// ═══════════════════════════════════════════ 4. add
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: true, ...STATE } } });
  await tick(); await tick();
  ui.ids['handoff-new-id'].value = 'cmd:yt-dlp';
  ui.ids['handoff-add-btn'].dispatch('click', { preventDefault() {} });
  await tick();
  const msg = ui.sent.filter(m => m.action === 'downloads-handoff:set-handlers').pop();
  eq(msg.handlers[3].id, 'cmd:yt-dlp', '4.1 a cmd: handler is added');
  eq(msg.handlers[3].args, '{url}', '4.2 with a usable default template, not an empty one');
  eq(ui.ids['handoff-new-id'].value, '', '4.3 and the input is cleared');
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: true, ...STATE } } });
  await tick(); await tick();
  ui.ids['handoff-new-id'].value = 'uget';
  ui.ids['handoff-add-btn'].dispatch('click', { preventDefault() {} });
  await tick();
  const msg = ui.sent.filter(m => m.action === 'downloads-handoff:set-handlers').pop();
  eq(msg.handlers[3].args, '', '4.4 a non-cmd handler gets no template');
}
{
  // Enter in the text field adds, like the netiface editor
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: true, ...STATE } } });
  await tick(); await tick();
  ui.ids['handoff-new-id'].value = 'cmd:curl';
  ui.ids['handoff-new-id'].dispatch('keydown', { key: 'Enter', preventDefault() {} });
  await tick();
  ok(ui.sent.some(m => m.action === 'downloads-handoff:set-handlers'), '4.5 Enter adds a handler');
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: true, ...STATE } } });
  await tick(); await tick();
  ui.ids['handoff-new-id'].value = '   ';
  ui.ids['handoff-add-btn'].dispatch('click', { preventDefault() {} });
  await tick();
  ok(!ui.sent.some(m => m.action === 'downloads-handoff:set-handlers'), '4.6 an empty id is not sent');
  ok(/Type a handler id/.test(ui.ids['handoff-status'].textContent), '4.7 and says so');
}
{
  // the cap is enforced in the UI as well as the background
  const full = { ...STATE, handlers: Array.from({ length: 16 }, (_, i) => ({ ...HANDLERS[1], index: i, id: 'cmd:p' + i })) };
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': full, 'downloads-handoff:set-handlers': { ok: true, ...full } } });
  await tick(); await tick();
  eq(rowsOf(ui).length, 16, '4.8 sixteen rows render');
  ok(ui.ids['handoff-add-btn'].disabled === true, '4.9 and Add is disabled at the cap');
  ok(/limit/.test(ui.ids['handoff-add-btn'].title || ''), '4.10 with the reason in its tooltip');
  ui.ids['handoff-new-id'].value = 'cmd:overflow';
  ui.ids['handoff-add-btn'].dispatch('click', { preventDefault() {} });
  await tick();
  ok(!ui.sent.some(m => m.action === 'downloads-handoff:set-handlers'), '4.11 and clicking it anyway sends nothing');
}

// ═══════════════════════════════════════════ 5. the master control
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-enabled': { ok: true, ...STATE } } });
  await tick(); await tick();
  eq(ui.ids['handoff-enabled'].value, 'auto', '5.1 the tri-state pref renders as a select, showing auto');
  ui.ids['handoff-enabled'].value = 'false';
  ui.ids['handoff-enabled'].dispatch('change', {});
  await tick();
  const msg = ui.sent.filter(m => m.action === 'downloads-handoff:set-enabled').pop();
  eq(msg.mode, 'false', '5.2 changing it writes the STRING, not a boolean');
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': { ...STATE, mode: 'false', enabled: false }, 'downloads-handoff:set-enabled': { ok: true, ...STATE, mode: 'false' } } });
  await tick(); await tick();
  eq(ui.ids['handoff-enabled'].value, 'false', '5.3 a stored false renders as false');
  ok(/\(off\)/.test(ui.ids['handoff-mode'].textContent), '5.4 and the summary line says off', ui.ids['handoff-mode'].textContent);
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-enabled': { ok: true, ...STATE } } });
  await tick(); await tick();
  ok(/2 available/.test(ui.ids['handoff-mode'].textContent), '5.5 the summary counts available handlers', ui.ids['handoff-mode'].textContent);
}

// ═══════════════════════════════════════════ 6. failures are visible
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': { ok: false, error: 'row 1: "wget" is not a handler' } } });
  await tick(); await tick();
  rowsOf(ui)[1].children[0].value = 'wget';
  rowsOf(ui)[1].children[0].dispatch('change', {});
  await tick(); await tick();
  ok(/is not a handler/.test(ui.ids['handoff-status'].textContent), '6.1 a refused write shows the background\'s reason', ui.ids['handoff-status'].textContent);
  ok(ui.ids['handoff-status'].classList.contains('error'), '6.2 marked as an error');
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE, 'downloads-handoff:set-handlers': STATE } });
  await tick(); await tick();
  rowsOf(ui)[0].children[0].dispatch('change', {});
  await tick(); await tick();
  eq(ui.ids['handoff-status'].textContent, '', '6.3 a successful write clears the status line');
}

// ═══════════════════════════════════════════ 7. expand / collapse
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE } });
  await tick(); await tick();
  eq(ui.ids['handoff-header'].getAttribute('aria-expanded'), 'false', '7.1 collapsed by default');
  ok(ui.ids['handoff-body'].hidden === true, '7.2 and the body is hidden');
  ui.ids['handoff-header'].dispatch('click', {});
  eq(ui.ids['handoff-header'].getAttribute('aria-expanded'), 'true', '7.3 clicking the header expands it');
  ok(ui.ids['handoff-body'].hidden === false, '7.4 and shows the body');
  ui.ids['handoff-header'].dispatch('click', {});
  eq(ui.ids['handoff-header'].getAttribute('aria-expanded'), 'false', '7.5 and collapses again');
  const html = fs.readFileSync(POPUP_HTML, 'utf8');
  ok(/<button[^>]*id="handoff-header"/.test(html), '7.6 the header is a real <button> in the markup, so Enter/Space work');
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE }, stored: { rozelynx_handoff_expanded: true } });
  await tick(); await tick();
  eq(ui.ids['handoff-header'].getAttribute('aria-expanded'), 'true', '7.7 the remembered state is restored');
}

// ═══════════════════════════════════════════ 8. empty state
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': { ...STATE, handlers: [] } } });
  await tick(); await tick();
  ok(ui.ids['handoff-empty'].hidden === false, '8.1 the empty state shows with no handlers');
  ok(/stay in the browser/.test(fs.readFileSync(POPUP_HTML, 'utf8')),
    '8.2 and the empty state says what that means');
  eq(ui.ids['handoff-count'].textContent, '', '8.3 the count badge is empty, not "0 handlers"');
  eq(rowsOf(ui).length, 0, '8.4 and no rows');
}
{
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE } });
  await tick(); await tick();
  ok(ui.ids['handoff-empty'].hidden === true, '8.5 the empty state is hidden when there are handlers');
}

// ═══════════════════════════════════════════ 9. popup markup agrees with the script
{
  const html = fs.readFileSync(POPUP_HTML, 'utf8');
  const ui = makeUi({ replies: { 'downloads-handoff:handlers': STATE } });
  await tick(); await tick();
  // every getElementById the script performs must exist in the real markup
  const src = fs.readFileSync(path.join(DIR, 'handlers-ui.js'), 'utf8');
  const wanted = [...src.matchAll(/getElementById\('([^']+)'\)/g)].map(m => m[1]);
  const missing = wanted.filter(id => !html.includes('id="' + id + '"'));
  eq(missing, [], '9.1 every id the editor needs exists in popup.html');
  // and no id is declared twice, which would silently bind the wrong element
  const ids = [...html.matchAll(/id="([^"]+)"/g)].map(m => m[1]);
  eq(ids.filter(i => ids.indexOf(i) !== ids.lastIndexOf(i)), [], '9.2 no duplicate ids in popup.html');
  ok(html.includes('id="handoff-section" hidden'), '9.3 the section is hidden in the markup');
  ok(!/src="\.\.\/downloads-handoff/.test(html), '9.4 the editor is NOT referenced by a static <script> tag');
  // every class the editor sets has a rule in the stylesheet
  const classes = ['handoff-row', 'handoff-id', 'handoff-args', 'handoff-enabled', 'handoff-note', 'handoff-add', 'handoff-empty', 'handoff-status', 'handoff-hint'];
  const missingCss = classes.filter(c => !html.includes('.' + c));
  eq(missingCss, [], '9.5 every class the editor uses has a stylesheet rule');
  // the section is below the URL-rules one, i.e. last
  ok(html.indexOf('id="handoff-section"') > html.indexOf('id="urlrules-section"'),
    '9.6 the hand-off section comes after the URL-rules section');
}

// ═══════════════════════════════════════════ 10. content.js
{
  const env = makeDomEnv({ replies: { 'downloads-handoff:intercept': { ok: true, via: 'cmd:aria2c' } } });
  env.doc.URL = 'https://example.com/page';   // the content script sends document.URL
  vm.createContext(env.sandbox);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'content.js'), 'utf8'), env.sandbox, { filename: 'content.js' });

  function link(href, attrs) {
    const a = new El('a');
    a.setAttribute('href', href);
    Object.keys(attrs || {}).forEach(k => a.setAttribute(k, attrs[k]));
    env.doc.body.appendChild(a);
    return a;
  }
  function click(target) {
    env.fire(target, 'mousedown', { button: 0 });
    const ev = env.fire(target, 'click', { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
    return ev;
  }
  await tick();

  // a file extension is a candidate
  let a = link('https://e.com/pkg.tar.gz');
  let ev = click(a);
  ok(ev.defaultPrevented, '10.1 a .tar.gz link click is prevented');
  let msg = env.sent.filter(m => m.action === 'downloads-handoff:intercept').pop();
  ok(!!msg, '10.2 and the background is asked');
  eq(msg.data.url, 'https://e.com/pkg.tar.gz', '10.3 with the url');
  eq(msg.data.pageUrl, 'https://example.com/page', '10.4 and the page url');
  eq(msg.data.referrer, 'https://example.com/page', '10.5 and the referrer');

  // inline-displayable types are left alone
  for (const href of ['https://e.com/a.html', 'https://e.com/a.pdf',
                      'https://e.com/a.mp4', 'https://e.com/a.txt',
                      'https://e.com/a.png']) {
    const before = env.sent.length;
    const t = link(href);
    const e2 = click(t);
    ok(!e2.defaultPrevented, '10.6 left alone: ' + href);
    eq(env.sent.length, before, '10.7 and the background is not bothered for ' + href);
  }

  // a download attribute counts whatever it says
  const before = env.sent.length;
  const t = link('https://e.com/anything', { download: '' });
  const e3 = click(t);
  ok(e3.defaultPrevented, '10.8 a download attribute is a candidate whatever the extension');
  ok(env.sent.length > before, '10.9 and is asked about');
  eq(env.sent.filter(m => m.action === 'downloads-handoff:intercept').pop().data.filename, '',
    '10.10 an empty download attribute yields an empty filename, not undefined');

  // modified clicks and an already-handled event are left to the browser
  for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }]) {
    const b2 = env.sent.length;
    const t2 = link('https://e.com/x.zip');
    env.fire(t2, 'mousedown', { button: 0 });
    const e4 = env.fire(t2, 'click', Object.assign({ button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false }, over));
    ok(!e4.defaultPrevented, '10.11 a modified click is left alone: ' + JSON.stringify(over));
    eq(env.sent.length, b2, '10.12 and not sent');
  }
  {
    const b3 = env.sent.length;
    const t3 = link('https://e.com/y.zip');
    env.fire(t3, 'mousedown', { button: 0 });
    const e5 = env.fire(t3, 'click', { button: 0, defaultPrevented: true, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
    eq(env.sent.length, b3, '10.13 an already-handled click is not touched');
  }
  {
    // href="#" is not a download
    const b4 = env.sent.length;
    const t4 = link('#');
    const e6 = click(t4);
    ok(!e6.defaultPrevented, '10.14 href="#" is not a download');
    eq(env.sent.length, b4, '10.15 and not sent');
  }
  {
    // a decline re-navigates, so the browser does what it would have done
    const env2 = makeDomEnv({ replies: { 'downloads-handoff:intercept': { ok: false, reason: 'no handler is available' } } });
    vm.createContext(env2.sandbox);
    vm.runInContext(fs.readFileSync(path.join(DIR, 'content.js'), 'utf8'), env2.sandbox, { filename: 'content.js' });
    const a2 = new El('a');
    a2.setAttribute('href', 'https://e.com/declined.zip');
    env2.doc.body.appendChild(a2);
    let assigned = null;
    env2.sandbox.location.assign = u => { assigned = u; };
    env2.fire(a2, 'mousedown', { button: 0 });
    env2.fire(a2, 'click', { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
    await tick(); await tick();
    eq(assigned, 'https://e.com/declined.zip', '10.16 a declined candidate is re-navigated');
  }
  {
    // the authoritative extension list rides back with the reply
    const env3 = makeDomEnv({ replies: { 'downloads-handoff:intercept': { ok: true, config: { linkIntercept: true, linkExtensions: ['weird'] } } } });
    vm.createContext(env3.sandbox);
    vm.runInContext(fs.readFileSync(path.join(DIR, 'content.js'), 'utf8'), env3.sandbox, { filename: 'content.js' });
    // First a link the BUILT-IN list already calls a download, so the script
    // gets a reply at all - the authoritative list travels back with a reply,
    // so a link the built-in list ignores teaches the script nothing.
    const a3 = new El('a');
    a3.setAttribute('href', 'https://e.com/first.zip');
    env3.doc.body.appendChild(a3);
    env3.fire(a3, 'mousedown', { button: 0 });
    env3.fire(a3, 'click', { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
    await tick(); await tick();
    // ".zzz" is in neither list, so this must be left alone
    const aZzz = new El('a');
    aZzz.setAttribute('href', 'https://e.com/other.zzz');
    env3.doc.body.appendChild(aZzz);
    env3.fire(aZzz, 'mousedown', { button: 0 });
    const eZzz = env3.fire(aZzz, 'click', { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
    ok(!eZzz.defaultPrevented, '10.17a an extension nobody lists is still left alone');
    const a4 = new El('a');
    a4.setAttribute('href', 'https://e.com/second.weird');
    env3.doc.body.appendChild(a4);
    env3.fire(a4, 'mousedown', { button: 0 });
    const e7 = env3.fire(a4, 'click', { button: 0, ctrlKey: false, metaKey: false, shiftKey: false, altKey: false });
    ok(e7.defaultPrevented, '10.17 the background-supplied extension list replaces the built-in one');
  }
  {
    // the action name the content script sends is the new one
    const src = fs.readFileSync(path.join(DIR, 'content.js'), 'utf8');
    ok(src.includes("'downloads-handoff:intercept'"), '10.18 the action is downloads-handoff:intercept');
    ok(!/downloads-uget/.test(src), '10.19 and no old action name survives');
  }
}

// ═══════════════════════════════════════════ 11. integration: the real editor
// against the real background, in one context.
//
// The sections above drive the editor with a hand-written reply, which cannot
// see a bug in the background's own availability reporting - the editor would
// render whatever the stub said. This section shares one sandbox between the
// two real files, so what the editor shows is what the background decided, and
// an edit in the UI is an edit in the prefs the background reads.
{
  const PREFS = {
    'rozelynx.downloads.handler.0.id': 'uget',
    'rozelynx.downloads.handler.1.id': 'cmd:aria2c',
    'rozelynx.downloads.handler.1.args': '-x 4 {url}',
    'rozelynx.downloads.handler.2.id': 'cmd:yt-dlp',
    'rozelynx.downloads.handler.3.id': 'ext:dl@x',
  };
  const ui = makeUi({
    live: true, prefs: PREFS,
    onPath: ['aria2c'],            // yt-dlp is deliberately NOT on PATH
    uget: true,
    installed: { 'dl@x': { enabled: false } },
  });
  await tick(); await tick(); await tick();

  ok(ui.ids['handoff-section'].hidden === false, '11.1 the section is revealed by the real module answering');
  eq(rowsOf(ui).map(r => r.children[0].value),
    ['uget', 'cmd:aria2c', 'cmd:yt-dlp', 'ext:dl@x'], '11.2 the rows come from the real pref reader');
  eq(notesOf(ui).map(n => n.classList.contains('off')), [false, false, true, true],
    '11.3 availability is the BACKGROUND\'s answer, not a stub: uget and aria2c up, yt-dlp and the extension down');
  ok(/not found on PATH/.test(notesOf(ui)[2].textContent), '11.4 and the reason is the host\'s own', notesOf(ui)[2].textContent);
  ok(/not installed or not enabled/.test(notesOf(ui)[3].textContent), '11.5 and so is the extension\'s');
  ok(/2 available/.test(ui.ids['handoff-mode'].textContent), '11.6 the summary counts the same two', ui.ids['handoff-mode'].textContent);

  // an edit in the editor is a pref the background then reads back
  rowsOf(ui)[2].children[2].checked = true;
  rowsOf(ui)[2].children[2].dispatch('change', {});
  await tick(); await tick();
  eq(ui.bgPrefs['rozelynx.downloads.handler.2.enabled'], true, '11.7 the checkbox reached the pref');
  ok(!/disabled/.test(notesOf(ui)[2].textContent), '11.8 the note no longer says disabled', notesOf(ui)[2].textContent);
  eq(notesOf(ui)[2].classList.contains('off'), true,
    '11.8b and it is STILL marked unavailable: enabling a handler is not installing its program');

  // deleting a row through the editor CLEARS the prefs, and the re-read list
  // the editor renders agrees
  rowsOf(ui)[3].children[3].dispatch('click', { preventDefault() {} });
  await tick(); await tick();
  ok(!('rozelynx.downloads.handler.3.id' in ui.bgPrefs), '11.9 the deleted row\'s pref is GONE, not blanked');
  eq(rowsOf(ui).length, 3, '11.10 and the editor shows three rows');
  eq(rowsOf(ui).map(r => r.children[0].value), ['uget', 'cmd:aria2c', 'cmd:yt-dlp'], '11.11 reindexed');

  // the master control writes the string and the background re-resolves
  ui.ids['handoff-enabled'].value = 'false';
  ui.ids['handoff-enabled'].dispatch('change', {});
  await tick(); await tick();
  eq(ui.bgPrefs['rozelynx.downloads.handoff.enabled'], 'false', '11.12 the tri-state pref is written as a string');
  ok(/\(off\)/.test(ui.ids['handoff-mode'].textContent), '11.13 and the summary says off', ui.ids['handoff-mode'].textContent);

  // and a download is no longer intercepted, through the same real module
  ui.sandbox.browser.downloads.onCreated._list[0]({
    id: 1, url: 'https://e.com/a.iso', finalUrl: 'https://e.com/a.iso',
    filename: '/tmp/a.iso', referrer: '', fileSize: 9999999, incognito: false,
  });
  await tick(); await tick();
  eq(ui.nativeCalls.filter(c => c.action === 'handoff').length, 0, '11.14 with the mode off nothing is handed off');
}
{
  // the same integration, with the mode on: the FIRST available handler runs
  const ui = makeUi({
    live: true,
    prefs: {
      'rozelynx.downloads.handler.0.id': 'cmd:yt-dlp',
      'rozelynx.downloads.handler.1.id': 'cmd:aria2c',
    },
    onPath: ['aria2c'],            // yt-dlp missing, so the list must fall through
  });
  await tick(); await tick(); await tick();
  eq(notesOf(ui).map(n => n.classList.contains('off')), [true, false], '11.15 one up, one down');
  const created = {
    id: 2, url: 'https://e.com/b.zip', finalUrl: 'https://e.com/b.zip',
    filename: '/tmp/b.zip', referrer: '', fileSize: 9999999, incognito: false,
  };
  // the real listener registered by the real background
  const fns = ui.sandbox.browser.downloads.onCreated._list;
  fns[0](created);
  await tick(); await tick(); await tick();
  const ran = ui.nativeCalls.filter(c => c.action === 'handoff').map(c => c.msg.program);
  eq(ran, ['aria2c'], '11.16 the unavailable handler is skipped and the available one runs');
}

}

run('downloads-handoff-editor', main);
