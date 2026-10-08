/* The download hand-off module's background page.
 *
 * D.7. The real modules/downloads-handoff/background.js is loaded VERBATIM
 * into a vm against a stubbed WebExtension; nothing in it is reimplemented. It
 * is an IIFE with no exports, so it is driven the only way a browser can drive
 * it: through the runtime.onMessage listener it registers - and the contract
 * for that is lib/webext.js, because "the listener declined" and "the listener
 * has not answered yet" are different outcomes and modelling them the same way
 * makes a test hang instead of rejecting.
 *
 * Run:  node tests/downloads-handoff-module.js [<extension root>]
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ok, eq, run, tick } = require('./lib/check');
const { listenerStub } = require('./lib/webext');
const { root, requireTree } = require('./lib/roots');

const ROOT = requireTree(root(process.argv), 'extension tree');
const DIR = path.join(ROOT, 'modules/downloads-handoff');
if (!fs.existsSync(path.join(DIR, 'background.js'))) {
  console.error('FATAL: no downloads-handoff/background.js under ' + ROOT);
  process.exit(2);
}

// ── a stubbed WebExtension ─────────────────────────────────────────
function makeEnv(opts) {
  opts = opts || {};
  const prefs = Object.assign({}, opts.prefs || {});
  const calls = { native: [], messages: [], extMessages: [], downloads: [], menus: [], ctx: [] };
  const onCreated = [];
  const ctxClicked = [];
  let menuHandler = null;

  const replies = opts.replies || {};
  const nativeReplies = opts.native || function (action, msg) {
    if (action === 'uget-probe') return Promise.resolve({ ok: true, integrator: 'uget-integrator', version: '1', uget: '2.2.3' });
    if (action === 'handoff-probe') {
      const on = (opts.onPath || ['aria2c', 'wget', 'curl', 'yt-dlp', 'hand-off-target'])[0];
      return Promise.resolve({ ok: true, program: msg.program, path: '/usr/bin/' + msg.program });
    }
    if (action === 'uget') return Promise.resolve({ ok: true, via: 'uget-integrator' });
    if (action === 'handoff') return Promise.resolve({ ok: true, program: msg.program, pid: 4242 });
    return Promise.reject(new Error('no native reply for ' + action));
  };

  const bg = listenerStub();
  const storage = {};
  const onChanged = [];

  const browser = {
    runtime: {
      id: 'rozelynx-features@bytewheel.org',
      lastError: null,
      getURL: p => 'moz-extension://x/' + p,
      getManifest: () => ({ version: '1.0.55' }),
      // WebExtensions' own signature is sendMessage(extensionId, message);
      // the one-arg form is a message to our own modules.
      sendMessage: function (first, second) {
        if (second !== undefined) {
          const extId = first, msg = second;
          calls.extMessages.push({ id: extId, msg: msg });
          const r = (opts.extReplies || {})[extId];
          if (r === undefined) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
          if (r === null) return Promise.reject(new Error('Receiving end does not exist.'));
          if (r && r.__reject) return Promise.reject(new Error(r.error || 'rejected'));
          return Promise.resolve(r);
        }
        const msg = first;
        calls.messages.push(msg);
        if (msg && msg.action === 'netiface:available') {
          return Promise.resolve({ ok: true, data: { available: true } });
        }
        const r = replies[msg && msg.action];
        if (r === undefined) return Promise.reject(new Error('Could not establish connection. Receiving end does not exist.'));
        if (r && r.__reject) return Promise.reject(new Error(r.error || 'rejected'));
        return Promise.resolve(typeof r === 'function' ? r(msg) : r);
      },
      onMessage: bg.onMessage,
      sendNativeMessage: function (host, msg) {
        calls.native.push({ host: host, action: msg.action, msg: msg });
        let r;
        try { r = nativeReplies(msg.action, msg); } catch (e) { r = Promise.reject(e); }
        return Promise.resolve(r);
      },
    },
    storage: {
      local: {
        get(keys) {
          if (Array.isArray(keys)) { const o = {}; keys.forEach(k => { if (k in storage) o[k] = storage[k]; }); return Promise.resolve(o); }
          if (typeof keys === 'string') {
            const one = {};
            if (keys in storage) one[keys] = storage[keys];
            return Promise.resolve(one);
          }
          return Promise.resolve(Object.assign({}, storage));
        },
        set(obj) {
          const changes = {};
          Object.keys(obj).forEach(k => { changes[k] = { oldValue: storage[k], newValue: obj[k] }; storage[k] = obj[k]; });
          onChanged.forEach(fn => fn(changes, 'local'));
          return Promise.resolve();
        },
      },
      onChanged: { addListener: fn => onChanged.push(fn) },
    },
    downloads: {
      onCreated: { addListener: fn => onCreated.push(fn) },
      // Resolves with a BOOLEAN, as the real API does, and the boolean is
      // meaningful: false means the item was not cancellable (already
      // complete, already interrupted, never on the list). The stub used to
      // resolve undefined and the code ignored the value, so a false cancel
      // still erased and still handed off - the browser kept the file AND
      // uget fetched it, which is "I see both the normal download window and
      // the uget window". `opts.cancelResult` makes that reachable.
      cancel: id => {
        calls.downloads.push(['cancel', id]);
        return Promise.resolve(opts.cancelResult !== false);
      },
      erase: () => Promise.resolve(),
      download: a => { calls.downloads.push(['download', a.url]); return Promise.resolve(99); },
    },
    cookies: opts.cookies === false ? (opts.cookieCounter ? {
      getAll: () => {
        opts.cookieCounter.n++;
        return Promise.resolve([{ domain: '.e.com', httpOnly: false, path: '/', secure: false, expirationDate: 1, name: 'a', value: 'b' }]);
      },
    } : undefined) : {
      getAll: () => Promise.resolve(opts.cookies || [
        { domain: '.example.com', httpOnly: true, path: '/', secure: true, expirationDate: 1893456000, name: 'sid', value: 'abc' },
        { domain: '.example.com', httpOnly: false, path: '/', secure: false, expirationDate: null, name: 'pref', value: 'dark' },
      ]),
    },
    management: opts.management === false ? {} : {
      get: id => {
        const table = opts.installed || {};
        if (!(id in table)) return Promise.reject(new Error('No add-on with id ' + id));
        return Promise.resolve(Object.assign({ id: id }, table[id]));
      },
      onInstalled: { addListener() {} }, onEnabled: { addListener() {} },
      onDisabled: { addListener() {} }, onUninstalled: { addListener() {} },
    },
    contextMenus: {
      create: (props, cb) => { calls.menus.push(props); if (cb) cb(); },
      removeAll: () => Promise.resolve(),
      onClicked: { addListener: fn => { menuHandler = fn; } },
    },
    rozelynxPrefs: opts.noPrefs ? undefined : {
      getPrefs(names) {
        return Promise.resolve((names || []).map(n => {
          if (!(n in prefs)) return { name: n, type: 'missing', value: null };
          const v = prefs[n];
          if (typeof v === 'boolean') return { name: n, type: 'boolean', value: v };
          if (typeof v === 'number') return { name: n, type: 'integer', value: v };
          return { name: n, type: 'string', value: String(v) };
        }));
      },
      setPrefs(map) {
        const errors = [];
        Object.keys(map).forEach(n => {
          const v = map[n];
          if (typeof v === 'boolean') prefs[n] = v;
          else if (typeof v === 'number' && Number.isInteger(v)) prefs[n] = v;
          else if (typeof v === 'string') prefs[n] = v;
          else errors.push(n + ': unsupported');
        });
        return Promise.resolve({ ok: errors.length === 0, written: Object.keys(map).length, error: errors.join('; ') });
      },
      clearPrefs(names) {
        let cleared = 0;
        (names || []).forEach(n => { if (n in prefs) { delete prefs[n]; cleared++; } });
        return Promise.resolve({ ok: true, cleared, error: '' });
      },
    },
  };
  if (opts.noPrefs) delete browser.rozelynxPrefs;

  const sandbox = {
    browser, console: { log() {}, debug() {}, warn() {}, error() {} },
    navigator: { userAgent: 'UA/1.0' },
    setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); if (t.unref) t.unref(); return t; },
    clearTimeout, fetch: opts.fetch || (() => Promise.reject(new Error('no network'))),
    Map, Set, Object, Array, String, Number, Boolean, RegExp, Error, JSON,
    Promise, Date, Math, isNaN, parseInt, parseFloat,
  };
  sandbox.self = sandbox; sandbox.globalThis = sandbox;
  vm.createContext(sandbox);
  vm.runInContext(fs.readFileSync(path.join(DIR, 'background.js'), 'utf8'), sandbox, { filename: 'background.js' });

  return {
    sandbox, browser, prefs, calls, onCreated, storage, onChanged, ctxClicked,
    ask(msg) { return bg.ask(msg); },
    fireCreated(item) { onCreated.forEach(fn => fn(item)); },
    fireCtx(info) { if (menuHandler) menuHandler(info); },
    nativeCalls: () => calls.native,
  };
}

// a prefs map shaped like a configured list
function P(handlers, extra) {
  const o = Object.assign({}, extra || {});
  handlers.forEach((h, i) => {
    o['rozelynx.downloads.handler.' + i + '.id'] = h.id;
    if (h.args !== undefined) o['rozelynx.downloads.handler.' + i + '.args'] = h.args;
    if (h.enabled !== undefined) o['rozelynx.downloads.handler.' + i + '.enabled'] = h.enabled;
  });
  return o;
}

// Probes succeed, hand-offs fail: "the handler is there and then said no".
// A test that means this must not make the PROBE fail too, or it ends up
// measuring resolveEnabled()'s 'auto' branch instead of the hand-off path.
const probeOkHandoffFails = (a) =>
  (a === 'handoff-probe' || a === 'uget-probe' || a === 'uget')
    ? Promise.resolve({ ok: true, path: '/usr/bin/aria2c', uget: '2.2.3', version: '1' })
    : Promise.reject(new Error('down'));

const item = (over) => Object.assign({ id: 7, url: 'https://e.com/big.iso', finalUrl: 'https://e.com/big.iso', filename: '/tmp/big.iso', referrer: 'https://e.com/page', fileSize: 5 * 1024 * 1024, incognito: false }, over || {});

async function main() {

// ═══════════════════════════════════════════ 1. describeHandler / id grammar
{
  const env = makeEnv({ prefs: P([{ id: 'uget' }, { id: 'cmd:aria2c' }, { id: 'ext:dl@x' }, { id: 'nonsense' }]) });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:handlers' });
  eq(r.handlers.map(h => h.kind), ['builtin', 'cmd', 'ext', 'unknown'],
    '1.1 the three shapes parse, and an unknown id is reported rather than guessed');
  eq(r.handlers[0].builtin, 'uget', '1.2 the builtin is named');
  eq(r.handlers[1].program, 'aria2c', '1.3 cmd: yields a program');
  eq(r.handlers[2].extId, 'dl@x', '1.4 ext: yields an extension id');
  ok(/not a known handler/.test(r.handlers[3].hint), '1.5 an unknown id explains itself');
}
{
  // a bare word must NOT silently become a program to run
  const env = makeEnv({ prefs: P([{ id: 'aria2c' }]) });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:handlers' });
  eq(r.handlers[0].kind, 'unknown', '1.6 a bare word is not promoted to cmd:');
}
{
  // unusable ids end the list rather than producing a broken row
  for (const bad of ['', '   ', 'ext:', 'cmd:']) {
    const env = makeEnv({ prefs: { 'rozelynx.downloads.handler.0.id': 'uget', 'rozelynx.downloads.handler.1.id': bad } });
    await tick();
    const r = await env.ask({ action: 'downloads-handoff:handlers' });
    eq(r.handlers.length, 1, '1.7 an unusable id stops the scan at ' + JSON.stringify(bad));
  }
}

// ═══════════════════════════════════════════ 2. the list is bounded and in order
{
  const many = [];
  for (let i = 0; i < 20; i++) many.push({ id: 'cmd:p' + i });
  const env = makeEnv({ prefs: P(many) });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:handlers' });
  eq(r.handlers.length, 16, '2.1 the reader stops at the documented cap');
  eq(r.maxHandlers, 16, '2.2 and reports the same cap the editor uses');
  eq(r.handlers.map(h => h.id), many.slice(0, 16).map(h => h.id), '2.3 in index order');
}
{
  // a gap ends the list: a handler after a hole is a live pref the editor
  // would not show
  const env = makeEnv({ prefs: { 'rozelynx.downloads.handler.0.id': 'uget', 'rozelynx.downloads.handler.2.id': 'cmd:aria2c' } });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:handlers' });
  eq(r.handlers.length, 1, '2.4 a gap in the indices ends the list');
}

// ═══════════════════════════════════════════ 3. auto detection
{
  const env = makeEnv({ prefs: P([{ id: 'uget' }]) });
  await tick();
  let r = await env.ask({ action: 'downloads-handoff:status' });
  ok(r.enabled === true, '3.1 auto is ON when the builtin probe answers');
  ok(r.mode === 'auto', '3.2 and the mode is still auto');
}
{
  const env = makeEnv({ prefs: P([{ id: 'cmd:not-a-real-program-xyz' }]), native: (a) => Promise.reject(new Error(a + ' not found on PATH')) });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:status' });
  ok(r.enabled === false, '3.3 auto is OFF when no handler is available');
  eq(r.availableCount, 0, '3.4 and says so');
}
{
  // 'auto' + one available among several is ON
  const env = makeEnv({
    prefs: P([{ id: 'cmd:aria2c' }, { id: 'ext:dl@x' }]),
    installed: { 'dl@x': { enabled: false } },
  });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:status' });
  ok(r.enabled === true, '3.5 one available handler is enough for auto');
  eq(r.handlers.map(h => h.available), [true, false], '3.6 and the editor is told which is which');
}
{
  // a disabled row is not available even when the program is on PATH
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c', enabled: false }]) });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:status' });
  ok(r.enabled === false, '3.7 a disabled handler does not turn auto on');
}
{
  // enabled = true forces on with nothing available
  const env = makeEnv({ prefs: P([{ id: 'cmd:nope-xyz' }], { 'rozelynx.downloads.handoff.enabled': 'true' }), native: () => Promise.reject(new Error('nope')) });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:status' });
  eq(r.mode, 'true', '3.8 the mode is reported verbatim');
  ok(r.enabled === true, '3.9 forced on even with nothing available');
}
{
  const env = makeEnv({ prefs: P([{ id: 'uget' }], { 'rozelynx.downloads.handoff.enabled': 'false' }) });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:status' });
  ok(r.enabled === false, '3.10 forced off wins over an available handler');
}
{
  // a hand-typed about:config value is normalised the same way the UI writes it
  const env = makeEnv({ prefs: P([{ id: 'uget' }], { 'rozelynx.downloads.handoff.enabled': 'yes' }) });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:status' });
  eq(r.mode, 'true', '3.11 "yes" in about:config is the same as "true"');
}

// ═══════════════════════════════════════════ 4. ordered hand-off
{
  // first handler wins, and the second is not called
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }, { id: 'cmd:wget' }]) });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/x.zip', filename: 'x.zip', referrer: '' } });
  ok(res.ok === true, '4.1 the download is handed off');
  eq(res.handler, 'cmd:aria2c', '4.2 the FIRST handler took it');
  eq(res.via, 'cmd:aria2c', '4.3 via the generic native verb');
  const handoffs = env.calls.native.filter(c => c.action === 'handoff');
  eq(handoffs.map(h => h.msg.program), ['aria2c'], '4.4 and the second handler was never run');
}
{
  // A successful link-layer hand-off must CLAIM the url, not just record it.
  // record() is history; nothing stopped downloads.onCreated from handing the
  // same url off again, so one click could produce two handoffs - two uget
  // windows - whenever the browser started a download despite the content
  // script's preventDefault (a page's own handler, a redirect that turns a
  // navigation into an attachment, a second frame). The failure path already
  // used bypass() for exactly this reason; the success path did not.
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]) });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/dup.zip', filename: 'dup.zip' } });
  ok(res.ok === true, '4.4a the link hand-off succeeded');
  // ...and now the browser reports a download for that same url anyway.
  env.fireCreated(item({ url: 'https://e.com/dup.zip', finalUrl: 'https://e.com/dup.zip' }));
  await tick();
  const handoffs = env.calls.native.filter(c => c.action === 'handoff');
  eq(handoffs.length, 1,
    '4.4b a download for the just-handed-off url is NOT handed off again',
    JSON.stringify(handoffs.map(h => h.msg.url)));
}
{
  // a failing handler falls through to the next, and the reason is recorded
  const env = makeEnv({
    prefs: P([{ id: 'cmd:aria2c' }, { id: 'cmd:wget' }]),
    native: (a, m) => {
      if (a === 'handoff-probe') return Promise.resolve({ ok: true, path: '/usr/bin/' + m.program });
      if (a !== 'handoff') return Promise.reject(new Error('x'));
      if (m.program === 'aria2c') return Promise.reject(new Error('aria2c refused'));
      return Promise.resolve({ ok: true, pid: 1 });
    },
  });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/x.zip' } });
  eq(res.handler, 'cmd:wget', '4.5 a declining handler falls through to the next');
}
{
  // nothing accepts -> the caller is told, and Layer A re-navigates
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]), native: probeOkHandoffFails });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/x.zip' } });
  ok(res.ok === false, '4.6 when no handler accepts, the link click is released');
  ok(/no handler accepted/.test(res.reason), '4.7 and the reason names the problem', res.reason);
  ok(/tried/.test(res.reason), '4.8 listing what was tried');
}
{
  // cross-extension hand-off
  const env = makeEnv({
    prefs: P([{ id: 'ext:dl@x' }]),
    installed: { 'dl@x': { enabled: true } },
    extReplies: { 'dl@x': { ok: true } },
  });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/x.zip', filename: 'x.zip' } });
  eq(res.via, 'ext:dl@x', '4.9 an ext: handler is driven by cross-extension message');
  const m = env.calls.extMessages[0] || { id: null, msg: {} };
  eq(m.id, 'dl@x', '4.10 addressed to that extension');
  eq(m.msg.target, 'download', '4.11 with the documented target');
  eq([m.msg.url, m.msg.filename], ['https://e.com/x.zip', 'x.zip'], '4.12 carrying url and filename');
  ok(!('cookies' in m.msg), '4.13 and no cookie file over a cross-extension message');
}
{
  // an ext: handler that does not answer is a decline, not a hang
  const env = makeEnv({ prefs: P([{ id: 'ext:dl@x' }, { id: 'cmd:wget' }]), installed: { 'dl@x': { enabled: true } }, noExtReply: true });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/x.zip' } });
  eq(res.handler, 'cmd:wget', '4.14 an ext: handler that rejects falls through');
}
{
  // the builtin still speaks the integrator protocol, with the cookies TEXT
  const env = makeEnv({ prefs: P([{ id: 'uget' }]) });
  await tick();
  await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/x.iso' } });
  const u = env.calls.native.find(c => c.action === 'uget');
  ok(!!u, '4.15 the builtin still uses the uget verb');
  ok(!!u && /sid\tabc/.test(u.msg.cookies), '4.16 with the Netscape cookie text, not a path');
  eq(u && u.msg.userAgent, 'UA/1.0', '4.17 and the user agent');
}
{
  // a cmd: handler is given cookie TEXT and the HOST makes the file
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c', args: '--load-cookies={cookies} {url}' }]) });
  await tick();
  await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/x.zip' } });
  const h = env.calls.native.find(c => c.action === 'handoff');
  ok(!!h && /sid\tabc/.test(h.msg.cookies), '4.18 a cmd: handler is sent the cookie text');
  eq(h && h.msg.args, '--load-cookies={cookies} {url}', '4.19 and the template verbatim');
  eq(h && h.msg.program, 'aria2c', '4.20 the program name');
}
{
  // cookies are read ONCE per hand-off, not once per handler tried. The stub
  // has to be installed before the module loads, because the module captures
  // `browser` at load time.
  const reads = { n: 0 };
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }, { id: 'cmd:wget' }]), cookies: false });
  env.browser.cookies = {
    getAll: () => {
      reads.n++;
      return Promise.resolve([{ domain: '.e.com', httpOnly: false, path: '/', secure: false, expirationDate: 1, name: 'a', value: 'b' }]);
    },
  };
  const env2 = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }, { id: 'cmd:wget' }]), cookies: false, cookieCounter: reads });
  await tick();
  await env2.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/x.zip' } });
  ok(reads.n <= 1, '4.21 the cookie jar is read at most once per hand-off', 'reads=' + reads.n);
}

// ═══════════════════════════════════════════ 5. the gate is unchanged
{
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]) });
  await tick();
  env.fireCreated(item({ url: 'blob:https://e.com/abc', finalUrl: '' }));
  await tick();
  eq(env.calls.downloads, [], '5.1 a blob: url is never intercepted');
  env.fireCreated(item({ url: 'https://e.com/a.iso' }));
  await tick();
  ok(env.calls.downloads.some(c => c[0] === 'cancel'), '5.2 an ordinary download is cancelled');
}
{
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }], { 'rozelynx.downloads.handoff.exclude': 'e.com/private' }) });
  await tick();
  env.fireCreated(item({ url: 'https://e.com/private/a.iso', finalUrl: 'https://e.com/private/a.iso' }));
  await tick();
  eq(env.calls.downloads, [], '5.3 the exclude list is honoured');
}
{
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]) });
  await tick();
  env.fireCreated(item({ incognito: true }));
  await tick();
  eq(env.calls.downloads, [], '5.4 a private download is never handed to another program');
}
{
  // min_size, and -1 meaning "unknown" rather than "small"
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }], { 'rozelynx.downloads.handoff.min_size': 1000 }) });
  await tick();
  env.fireCreated(item({ fileSize: 500 }));
  await tick();
  eq(env.calls.downloads, [], '5.5 a small file stays in the browser');
  env.fireCreated(item({ id: 8, fileSize: 5000 }));
  await tick();
  ok(env.calls.downloads.some(c => c[0] === 'cancel'), '5.6 a large one is handed off');
}
{
  // no Content-Length -> unknown -> handed off, not silently kept
  const env = makeEnv({
    prefs: P([{ id: 'cmd:aria2c' }]),
    fetch: () => Promise.resolve({ headers: { get: () => null } }),
  });
  await tick();
  env.fireCreated(item({ fileSize: -1 }));
  await tick();
  ok(env.calls.downloads.some(c => c[0] === 'cancel'), '5.7 a missing Content-Length is not evidence of a small file');
}
{
  // A cancel that resolves FALSE is not a cancel. browser.downloads.cancel
  // returns a boolean, and false means the item was not cancellable - already
  // complete, already interrupted, or never on the list. The code used to
  // ignore that value, so it erased and handed off anyway while the browser
  // kept the file: the download happened twice, once in Firefox and once in
  // uget, with both windows on screen at once. Nothing about a second
  // extension is needed for this; an uncancellable download is enough.
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]), cancelResult: false });
  await tick();
  env.fireCreated(item());
  await tick();
  ok(!env.calls.native.some(c => c.action === 'handoff'),
    '5.10 a cancel that resolved false does NOT hand off', JSON.stringify(env.calls.native.map(c => c.action)));
  ok(!env.calls.downloads.some(c => c[0] === 'download'),
    '5.11 ...and does not try to restore a download the browser still owns');
}
{
  // The converse: a successful cancel still hands off, so the fix above is not
  // simply "never hand off".
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]), cancelResult: true });
  await tick();
  env.fireCreated(item());
  await tick();
  ok(env.calls.native.some(c => c.action === 'handoff'),
    '5.12 a cancel that resolved true still hands off', JSON.stringify(env.calls.native.map(c => c.action)));
}
{
  // a failed hand-off after the cancel gives the download BACK
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]), native: probeOkHandoffFails });
  await tick();
  env.fireCreated(item());
  await tick();
  const seq = env.calls.downloads.map(c => c[0]);
  ok(seq.includes('cancel') && seq.includes('download'), '5.8 the download is restored, not lost', JSON.stringify(seq));
  eq(env.calls.downloads[env.calls.downloads.length - 1][1], 'https://e.com/big.iso', '5.9 with the right url');
}
{
  // the loop guard survives an event-page reload
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]), native: probeOkHandoffFails });
  await tick();
  env.fireCreated(item());
  await tick();
  ok(env.calls.downloads.some(c => c[0] === 'download'), '5.10 the restore happened');
  // the bypass set was written; a fresh module in the same storage must read it
  const env2 = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]) });
  Object.assign(env2.storage, env.storage);
  await tick();
  env2.fireCreated(item({ id: 9 }));
  await tick();
  eq(env2.calls.downloads, [], '5.11 the restored download is not re-intercepted after a reload');
}

// ═══════════════════════════════════════════ 6. the escape menu is manager-agnostic
{
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]) });
  await tick();
  const m = env.calls.menus[0];
  ok(m && !/uget/i.test(m.title), '6.1 the escape item is not named after any manager', m && m.title);
  ok(/RozeLynx/.test(m.title), '6.2 and still says which browser it means');
  env.fireCtx({ menuItemId: m.id, linkUrl: 'https://e.com/x.zip' });
  await tick();
  ok(env.calls.downloads.some(c => c[0] === 'download'), '6.3 the escape forces a browser download');
}

// ═══════════════════════════════════════════ 7. set-handlers
{
  const env = makeEnv({ prefs: P([{ id: 'uget' }]) });
  await tick();
  const res = await env.ask({
    action: 'downloads-handoff:set-handlers',
    handlers: [{ id: 'cmd:aria2c', args: '-x 4 {url}', enabled: true }, { id: 'uget' }],
  });
  ok(res.ok === true, '7.1 a valid list is accepted', JSON.stringify(res));
  eq(res.handlers.map(h => h.id), ['cmd:aria2c', 'uget'], '7.2 and the RE-READ list comes back');
  eq(env.prefs['rozelynx.downloads.handler.0.id'], 'cmd:aria2c', '7.3 written to the prefs');
  eq(env.prefs['rozelynx.downloads.handler.0.args'], '-x 4 {url}', '7.4 args too');
  eq(env.prefs['rozelynx.downloads.handler.1.id'], 'uget', '7.5 the second row');
  ok(!('rozelynx.downloads.handler.0.enabled' in env.prefs) ||
     env.prefs['rozelynx.downloads.handler.0.enabled'] === true, '7.6 enabled is written');
}
{
  // shrinking CLEARS the stale indices rather than blanking them
  const env = makeEnv({ prefs: P([{ id: 'uget' }, { id: 'cmd:aria2c' }, { id: 'cmd:wget' }]) });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:set-handlers', handlers: [{ id: 'uget' }] });
  ok(res.ok === true, '7.7 a shrink is accepted');
  eq(res.handlers.length, 1, '7.8 and one handler is left');
  ['1', '2'].forEach(i => ['id', 'args', 'enabled'].forEach(f => {
    ok(!('rozelynx.downloads.handler.' + i + '.' + f in env.prefs),
      '7.9 handler.' + i + '.' + f + ' is CLEARED, not blanked');
  }));
}
{
  const env = makeEnv({ prefs: P([{ id: 'uget' }]) });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:set-handlers', handlers: [{ id: 'wget' }] });
  ok(res.ok === false, '7.10 a bare word is refused on write too');
  ok(/not a handler/.test(res.error), '7.11 with the reason', res.error);
  eq(env.prefs['rozelynx.downloads.handler.0.id'], 'uget', '7.12 and nothing was written');
}
{
  // the reader SHOWS a hand-written unknown row (with an explanation) even
  // though the writer refuses it: showing what about:config holds and refusing
  // to save something unusable are different jobs.
  const env = makeEnv({ prefs: P([{ id: 'wget' }]) });
  await tick();
  const r = await env.ask({ action: 'downloads-handoff:handlers' });
  eq(r.handlers.map(h => h.kind), ['unknown'], '7.13 a hand-written unknown row is still shown');
  ok(/not a known handler/.test(r.handlers[0].hint), '7.14 with an explanation');
  ok(r.enabled === false, '7.15 and it is not counted as available');
}
{
  const env = makeEnv({ prefs: P([{ id: 'uget' }]) });
  await tick();
  const many = []; for (let i = 0; i < 17; i++) many.push({ id: 'cmd:p' + i });
  const res = await env.ask({ action: 'downloads-handoff:set-handlers', handlers: many });
  ok(res.ok === false && /at most 16/.test(res.error), '7.13 writing past the cap is refused', res.error);
}
{
  // a cmd: row with an empty args string records it rather than skipping it
  const env = makeEnv({ prefs: P([{ id: 'uget' }]) });
  await tick();
  await env.ask({ action: 'downloads-handoff:set-handlers', handlers: [{ id: 'cmd:aria2c', args: '' }] });
  eq(env.prefs['rozelynx.downloads.handler.0.args'], '', '7.14 an empty args template is stored as ""');
}
{
  const env = makeEnv({ prefs: P([{ id: 'uget' }]), noPrefs: true });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:set-handlers', handlers: [] });
  ok(res.ok === false && /prefs API/.test(res.error), '7.15 with no prefs API the write is refused, not silently dropped', res.error);
}

// ═══════════════════════════════════════════ 8. set-enabled
{
  const env = makeEnv({ prefs: P([{ id: 'uget' }]) });
  await tick();
  let r = await env.ask({ action: 'downloads-handoff:set-enabled', mode: 'false' });
  ok(r.ok === true, '8.1 the mode can be set');
  eq(r.mode, 'false', '8.2 and comes back normalised');
  eq(env.prefs['rozelynx.downloads.handoff.enabled'], 'false', '8.3 written to the pref');
  r = await env.ask({ action: 'downloads-handoff:set-enabled', mode: 'nonsense' });
  eq(r.mode, 'auto', '8.4 an unrecognised value falls back to auto rather than erroring');
}

// ═══════════════════════════════════════════ 9. message hygiene
{
  const env = makeEnv({ prefs: P([{ id: 'uget' }]) });
  await tick();
  // The listener must not claim another module's message. Returning false is
  // how it declines, and the observable consequence is that the sender's
  // promise REJECTS - so the rejection is the assertion.
  for (const action of ['mouse-gestures:do-something', 'pwa:launch',
                        'netiface:urlrules', 'downloads-uget:intercept',
                        'downloads-uget:status', 'unknown', null]) {
    let rejected = false;
    await env.ask({ action: action }).catch(() => { rejected = true; });
    ok(rejected, '9.1 not claimed: ' + String(action));
  }
  let answered = 0;
  await env.ask({ action: 'downloads-handoff:status' }).then(() => { answered++; }).catch(() => { });
  eq(answered, 1, '9.2 while its OWN actions are still answered');
  ok(!env.calls.messages.some(m => m && String(m.action || '').indexOf('downloads-uget') === 0),
    '9.3 no old action name is emitted anywhere');
}

// ═══════════════════════════════════════════ 10. history
{
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]) });
  await tick();
  await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/one.zip', filename: 'one.zip' } });
  await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/two.zip' } });
  const r = await env.ask({ action: 'downloads-handoff:status' });
  eq(r.history.map(h => h.handler), ['cmd:aria2c', 'cmd:aria2c'], '10.1 both hand-offs are recorded');
  eq(r.history[0].filename, 'one.zip', '10.2 with the filename');
  eq(r.history[0].layer, 'link', '10.3 and the layer that caught it');
  eq(r.history[0].via, 'cmd:aria2c', '10.4 and the path taken');
}

// ═══════════════════════════════════════════ 11. deferral to another integration
//
// Two integrations that both hook downloads.onCreated do not compose: one
// click, two hand-offs, two uget windows, and a race over downloads.cancel()
// that leaves the browser's copy and the manager's copy on screen together.
// `rozelynx.downloads.handoff.defer_to` names an add-on this module stands
// down for.
//
// The interesting half is the NEGATIVE cases. The pref is an ID rather than a
// boolean precisely so that standing down for an add-on that is not there
// cannot happen: honouring it blindly would leave every download to the
// browser with nothing managing them, and no way to tell why. So each of these
// asserts the refusal to defer.
{
  const env = makeEnv({
    prefs: P([{ id: 'cmd:aria2c' }], { 'rozelynx.downloads.handoff.defer_to': 'other@x' }),
    installed: { 'other@x': { enabled: true } },
  });
  await tick();
  const st = await env.ask({ action: 'downloads-handoff:status' });
  eq(st.enabled, false, '11.1 a deferral target that is enabled switches hand-off OFF');
  env.fireCreated(item());
  await tick(); await tick();
  ok(!env.calls.native.some(c => c.action === 'handoff'),
    '11.2 and a download is NOT handed off while standing down');
}
{
  // Layer A must stand down too, or the click is eaten and handed off by the
  // message path while the other integration also intercepts - the doubling
  // again, from the other side.
  const env = makeEnv({
    prefs: P([{ id: 'cmd:aria2c' }], { 'rozelynx.downloads.handoff.defer_to': 'other@x' }),
    installed: { 'other@x': { enabled: true } },
  });
  await tick();
  const res = await env.ask({ action: 'downloads-handoff:intercept', data: { url: 'https://e.com/x.zip' } });
  eq(res.ok, false, '11.3 the link layer declines too');
  ok(/deferring to other@x/.test(res.reason || ''), '11.4 and says who it is deferring to', res.reason);
  ok(!env.calls.native.some(c => c.action === 'handoff'), '11.5 nothing was handed off');
}
{
  const env = makeEnv({
    prefs: P([{ id: 'cmd:aria2c' }], { 'rozelynx.downloads.handoff.defer_to': 'other@x' }),
    installed: { 'other@x': { enabled: false } },
  });
  await tick();
  env.fireCreated(item());
  await tick(); await tick();
  ok(env.calls.native.some(c => c.action === 'handoff'),
    '11.6 a DISABLED target does not defer - this module still owns downloads');
}
{
  const env = makeEnv({
    prefs: P([{ id: 'cmd:aria2c' }], { 'rozelynx.downloads.handoff.defer_to': 'nope@x' }),
    installed: {},
  });
  await tick();
  env.fireCreated(item());
  await tick(); await tick();
  ok(env.calls.native.some(c => c.action === 'handoff'),
    '11.7 an unknown target does not defer');
}
{
  // No management API at all (a build without it, or a stub): deferring on a
  // guess is the same failure as 11.7, so it must not.
  const env = makeEnv({
    prefs: P([{ id: 'cmd:aria2c' }], { 'rozelynx.downloads.handoff.defer_to': 'other@x' }),
    management: false,
  });
  await tick();
  env.fireCreated(item());
  await tick(); await tick();
  ok(env.calls.native.some(c => c.action === 'handoff'),
    '11.8 no management API means no deferral');
}
{
  // The default: empty defer_to leaves everything exactly as it was.
  const env = makeEnv({ prefs: P([{ id: 'cmd:aria2c' }]) });
  await tick();
  env.fireCreated(item());
  await tick(); await tick();
  ok(env.calls.native.some(c => c.action === 'handoff'),
    '11.9 defer_to unset is the unchanged behaviour');
}

}

run('downloads-handoff-module', main);
