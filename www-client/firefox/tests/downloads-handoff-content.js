/* Layer A of the download hand-off: the content-script click hook.
 *
 * The real modules/downloads-handoff/content.js and the real background.js
 * are loaded VERBATIM into one sandbox and driven through the production
 * path - a capture-phase click on a page anchor, the runtime message, the
 * background's own gate - with nothing reimplemented. The module harness
 * (downloads-handoff-module.js) covers the background on its own; this one
 * exists because the click hook is where the "restore" contract lives:
 *
 *   A candidate the background declines is RELEASED, and the release has to
 *   restore the action the click would have performed - not a stand-in for
 *   it. A plain link would have navigated, so a release navigates. An anchor
 *   with a download attribute would have DOWNLOADED, so a release that
 *   navigates instead is a bug: it turns the page's own "download this file"
 *   into "open this file in this tab", and that is exactly what the
 *   synthetic menu's old Save-As did to every image it was given.
 *
 * The release paths here:
 *
 *   - the anchor is still in the tree: a second click, with the hook stood
 *     down for the duration of that one synchronous event, so the browser
 *     performs its own default action - picker and all.
 *   - the page removed the anchor while the answer was in flight: a
 *     detached anchor cannot be re-clicked, so the background starts the
 *     download itself (downloads-handoff:browser-download), which runs the
 *     Layer-B gate again and cannot loop.
 *
 * Run:  node tests/downloads-handoff-content.js [<extension root>]
 * The root is the extension source tree, a fresh assembly, or the portage
 * mirror's copy - see lib/roots.js.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ok, eq, run, tick } = require('./lib/check');
const { makeEnv, El } = require('./lib/fakedom');
const { root, requireTree } = require('./lib/roots');

const ROOT = requireTree(root(process.argv), 'extension tree');
const BG_SRC = path.join(ROOT, 'modules/downloads-handoff/background.js');
const CT_SRC = path.join(ROOT, 'modules/downloads-handoff/content.js');
for (const f of [BG_SRC, CT_SRC]) {
  if (!fs.existsSync(f)) {
    console.error('FATAL: missing ' + f);
    process.exit(2);
  }
}

// ── the real pair in one sandbox ────────────────────────────────────────
//
// The browser fields beyond fakedom's own are the ones the downloads-handoff
// background touches at load: the native host (probes, hand-offs), the
// cookie jar (the hand-off text), the prefs experiment API (the handler
// list), management (ext: handlers and deferral) and the context menu (the
// escape item). Everything else - storage, downloads, the message
// dispatcher's replies table - is fakedom's, which is the point of sharing it.
function loadPair(opts) {
  opts = opts || {};
  const env = makeEnv({ download: opts.download });
  const bg = { listeners: [] };

  // Wrap addListener rather than registering a listener of our own: the
  // real background registers through it, and a harness listener registered
  // before it would never be seen.
  const on = env.sandbox.browser.runtime.onMessage;
  const realAdd = on.addListener;
  on.addListener = function (fn) { bg.listeners.push(fn); return realAdd.call(on, fn); };
  env.sandbox.browser.runtime.sendMessage = function (msg) {
    env.sent.push(msg);
    if (!bg.listeners.length) return Promise.reject(new Error('Could not establish connection.'));
    return new Promise((resolve, reject) => {
      let settled = false;
      let keep;
      for (const fn of bg.listeners) {
        const k = fn(msg, { tab: { id: 1, windowId: 1 } }, (r) => { settled = true; resolve(r); });
        if (k === true) keep = true;
      }
      if (keep !== true && !settled) reject(new Error('Could not establish connection.'));
    });
  };
  env.sandbox.browser.runtime.getManifest = () => ({ version: '1.0.55' });
  env.sandbox.browser.runtime.sendNativeMessage = function (host, msg) {
    (env.nativeCalls = env.nativeCalls || []).push({ host, msg });
    let r;
    try { r = opts.native(msg.action, msg); } catch (e) { r = Promise.reject(e); }
    return Promise.resolve(r);
  };
  env.sandbox.browser.cookies = {
    getAll: () => Promise.resolve([]),
  };
  env.sandbox.browser.contextMenus = {
    create: (props) => { (env.menuCalls = env.menuCalls || []).push(props); },
    removeAll: () => Promise.resolve(),
    onClicked: { addListener: () => {} },
  };
  env.sandbox.browser.management = {
    get: (id) => Promise.reject(new Error('No add-on with id ' + id)),
    onInstalled: { addListener: () => {} }, onEnabled: { addListener: () => {} },
    onDisabled: { addListener: () => {} }, onUninstalled: { addListener: () => {} },
  };
  const prefs = opts.prefs || {};
  env.sandbox.browser.rozelynxPrefs = {
    getPrefs(names) {
      return Promise.resolve((names || []).map(n => {
        if (!(n in prefs)) return { name: n, type: 'missing', value: null };
        const v = prefs[n];
        if (typeof v === 'boolean') return { name: n, type: 'boolean', value: v };
        if (typeof v === 'number') return { name: n, type: 'integer', value: v };
        return { name: n, type: 'string', value: String(v) };
      }));
    },
  };

  vm.createContext(env.sandbox);
  vm.runInContext(fs.readFileSync(BG_SRC, 'utf8'), env.sandbox, { filename: BG_SRC });
  vm.runInContext(fs.readFileSync(CT_SRC, 'utf8'), env.sandbox, { filename: CT_SRC });
  return env;
}

// the default native host: every probe fails, so no handler is available,
// so the gate declines and the click is released. This is the default
// configuration - 'auto' with nothing configured to take a download.
const noHandler = () => Promise.reject(new Error('no native host'));

// a user click on `anchor`, through the real capture-phase listener
function click(env, anchor, extra) {
  return env.fire(anchor, 'click', Object.assign({ button: 0 }, extra || {}));
}

// the anchor's own click listeners, so a release's re-dispatch is
// observable from the page side of the sandbox
function spyClicks(anchor) {
  const seen = [];
  anchor.addEventListener('click', (ev) => seen.push(ev));
  return seen;
}

async function main() {

// ═══════════════════════════════════════════ 1. a declined plain link navigates
{
  const env = loadPair({ native: noHandler });
  await tick(); await tick();
  const a = new El('a');
  a.setAttribute('href', 'https://e.com/file.zip');
  env.doc.body.appendChild(a);
  click(env, a);
  await tick(); await tick();
  // extension-based candidates with no download attribute would have
  // navigated, so a navigation is a faithful restore.
  eq(env.assigned, ['https://e.com/file.zip'],
    '1.1 a declined .zip link is released as a navigation');
  eq(env.downloadCalls.length, 0,
    '1.2 and no browser download is invented for it',
    JSON.stringify(env.downloadCalls));
}
{
  // a declined NON-file link navigates too: the hook may have claimed the
  // click (an anchor with a download attribute), but a decline means the
  // browser's own behaviour, whatever the extension was.
  const env = loadPair({ native: noHandler });
  await tick(); await tick();
  const a = new El('a');
  a.setAttribute('href', 'https://e.com/page');
  a.setAttribute('download', 'page.html');
  env.doc.body.appendChild(a);
  const seen = spyClicks(a);
  click(env, a);
  await tick(); await tick();
  eq(env.assigned, [],
    '1.3 a declined download-attribute candidate is NOT navigated',
    JSON.stringify(env.assigned));
  ok(seen.length === 1 && seen[0].defaultPrevented === false,
    '1.4 it is re-clicked, with the browser free to perform its own default action',
    JSON.stringify(seen.map(e => e.defaultPrevented)));
}

// ═══════════════════════════════════════════ 2. the release is once, and the
// next real click is a candidate again
{
  const env = loadPair({ native: noHandler });
  await tick(); await tick();
  const a = new El('a');
  a.setAttribute('href', 'https://e.com/pic.png');
  a.setAttribute('download', 'pic.png');
  env.doc.body.appendChild(a);
  const seen = spyClicks(a);
  click(env, a);
  await tick(); await tick();
  eq(seen.length, 1, '2.1 one re-dispatched click for the one declined click, not a storm');
  const intercepts = env.sent.filter(m => m && m.action === 'downloads-handoff:intercept');
  eq(intercepts.length, 1, '2.2 and exactly one intercept was ever asked for it');
  // The flag that guards the re-dispatch is cleared afterwards: the user's
  // next click on the same anchor goes through the gate again (and, when
  // declined, releases again - each declined click is released exactly once).
  click(env, a);
  await tick(); await tick();
  eq(seen.length, 2, '2.3 the second real click is a candidate again, then released in turn');
  ok(seen.every(e => e.defaultPrevented === false),
    '2.3b and every re-dispatch leaves the browser free to act');
  eq(env.sent.filter(m => m && m.action === 'downloads-handoff:intercept').length, 2,
    '2.4 so the second click was intercepted, not skipped by a leaked flag');
  // and nothing accumulates
  eq(env.downloadCalls.length, 0, '2.5 still no browser download is invented');
}

// ═══════════════════════════════════════════ 3. a detached anchor releases
// through the background
{
  const env = loadPair({ native: noHandler });
  await tick(); await tick();
  const a = new El('a');
  a.setAttribute('href', 'https://e.com/report.pdf');
  a.setAttribute('download', 'report.pdf');
  env.doc.body.appendChild(a);
  click(env, a);
  // the page removes the anchor while the answer is in flight - a click
  // handler of its own, a route change.
  a.remove();
  await tick(); await tick();
  const rel = env.sent.filter(m => m && m.action === 'downloads-handoff:browser-download');
  eq(rel.length, 1, '3.1 a detached anchor asks the background to start the download');
  eq(rel[0] && [rel[0].data.url, rel[0].data.filename],
    ['https://e.com/report.pdf', 'report.pdf'],
    '3.2 carrying the URL and the download attribute\'s own suggested name');
  eq(env.downloadCalls.length, 1, '3.3 the background started exactly one download',
    JSON.stringify(env.downloadCalls));
  ok(env.downloadCalls[0] && env.downloadCalls[0].conflictAction === 'uniquify',
    '3.4 uniquified, as the module\'s own escape item restores');
  // Layer B sees the restore and declines it too: no handler is available,
  // so nothing cancels the download the release just started.
  env.onCreated.forEach(fn => fn({
    id: 7, url: 'https://e.com/report.pdf', finalUrl: 'https://e.com/report.pdf',
    filename: '/tmp/report.pdf', referrer: '', fileSize: 100, incognito: false,
  }));
  await tick(); await tick();
  ok(!env.downloadCalls.some(c => c.action === 'cancel'),
    '3.5 the restore is not re-intercepted - the decline was a decline');
}

// ═══════════════════════════════════════════ 4. a suggested name the API
// refuses is retried, not lost
{
  const env = loadPair({
    native: noHandler,
    download: (call) => call.filename
      ? { __reject: true, error: 'filename must not contain illegal characters' }
      : 44,
  });
  await tick(); await tick();
  const a = new El('a');
  a.setAttribute('href', 'https://e.com/f.bin');
  a.setAttribute('download', '../etc/passwd');
  env.doc.body.appendChild(a);
  click(env, a);
  a.remove();
  await tick(); await tick();
  eq(env.downloadCalls.length, 2, '4.1 a refused name is retried without it',
    JSON.stringify(env.downloadCalls));
  ok(env.downloadCalls[1] && !('filename' in env.downloadCalls[1]),
    '4.2 the retry carries no filename');
}

// ═══════════════════════════════════════════ 5. a taken candidate is not
// released at all
{
  const env = loadPair({
    native: (action) => {
      if (action === 'uget-probe') return Promise.resolve({ ok: true, uget: '2.2.3' });
      if (action === 'uget') return Promise.resolve({ ok: true });
      return Promise.reject(new Error('no such action'));
    },
    prefs: { 'rozelynx.downloads.handler.0.id': 'uget' },
  });
  await tick(); await tick();
  const a = new El('a');
  a.setAttribute('href', 'https://e.com/big.iso');
  a.setAttribute('download', 'big.iso');
  env.doc.body.appendChild(a);
  const seen = spyClicks(a);
  click(env, a);
  await tick(); await tick();
  eq(env.nativeCalls.filter(c => c.msg.action === 'uget').length, 1,
    '5.1 the configured handler took the download');
  eq(env.assigned, [], '5.2 nothing navigated');
  eq(seen.length, 0, '5.3 nothing was re-clicked: a hand-off is not a release');
  eq(env.downloadCalls.length, 0, '5.4 and no browser download was started either');
}

// ═══════════════════════════════════════════ 6. what is not a candidate
// stays untouched
{
  const env = loadPair({ native: noHandler });
  await tick(); await tick();
  const a = new El('a');
  a.setAttribute('href', 'https://e.com/doc.pdf');
  env.doc.body.appendChild(a);
  // a modified click means something else, and a text file link is not a
  // candidate by extension either
  click(env, a, { ctrlKey: true });
  click(env, a, { shiftKey: true });
  await tick(); await tick();
  eq(env.sent.filter(m => m && m.action === 'downloads-handoff:intercept').length, 0,
    '6.1 no intercept was ever asked');
  eq(env.assigned, [], '6.2 nothing was prevented or restored');

  const env2 = loadPair({ native: noHandler });
  await tick(); await tick();
  const p = new El('p');
  p.textContent = 'plain';
  env2.doc.body.appendChild(p);
  click(env2, p);
  await tick(); await tick();
  eq(env2.sent.filter(m => m && m.action === 'downloads-handoff:intercept').length, 0,
    '6.3 a click on nothing clickable asks nothing');
}

}

run('downloads-handoff-content', main);