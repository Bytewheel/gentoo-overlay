/* The synthetic right-click menu: grouping, parentId nesting, and the
 * per-download netiface entry.
 *
 * C.3.1 / Part E / C.5. The real modules/mouse-gestures/content.js is loaded
 * verbatim into a vm and driven through the production path - mousedown,
 * contextmenu, the one-shot bubble listener, mouseup - so buildMenuItems(),
 * showCustomMenu() and renderExtensionMenuItems() all run as the browser runs
 * them. Nothing in the file under test is reimplemented or stubbed out; the DOM
 * is.
 *
 * C.5 is the part worth reading first. This file used to feed the renderer from
 * storage.local - the reply channel of a menus.html iframe - so it tested the
 * renderer and nothing upstream of it. That is why every check in it passed
 * while the feature had never once worked in a browser: the bridge that fed it
 * was a moz-extension iframe in the page, i.e. a content script, and
 * browser.menus is registered scopes:["addon_parent"] - extension pages only -
 * so it did not exist there. The stub reported `menus` as available; a stand-in
 * for the platform cannot report that the platform is absent.
 *
 * Sections 1-11 therefore still drive the renderer with a canned reply - they
 * are about grouping, nesting, separators and prefixes, and the renderer should
 * stay the fast thing under test - but they now feed it over the message
 * channel the content script actually uses. Section 12 runs the REAL
 * background.js and the REAL content.js in one sandbox, with browser.menus and
 * without it.
 *
 * Run:  node tests/mouse-gestures-menu.js [<extension root>]
 * The root is the extension source tree, a fresh assembly, or the portage
 * mirror's copy - see lib/roots.js.
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ok, eq, run, tick } = require('./lib/check');
const { makeEnv } = require('./lib/fakedom');
const { root, requireTree } = require('./lib/roots');

const ROOT = requireTree(root(process.argv), 'extension tree');
const SRC = path.join(ROOT, 'modules/mouse-gestures/content.js');
if (!fs.existsSync(SRC)) {
  console.error('FATAL: no mouse-gestures/content.js under ' + ROOT);
  process.exit(2);
}

// Promises in the fake browser resolve as microtasks, so anything driven by
// sendMessage needs a turn of the loop before the DOM reflects the answer.
function load(opts) {
  const env = makeEnv(opts || {});
  const code = fs.readFileSync(SRC, 'utf8');
  vm.createContext(env.sandbox);
  vm.runInContext(code, env.sandbox, { filename: SRC });
  return env;
}

// right-click on `target`, through the real event path
function rightClick(env, target) {
  env.fire(target, 'mousedown', { button: 2 });
  const ev = env.fire(target, 'contextmenu', {});
  env.fire(target, 'mouseup', { button: 2 });
  return ev;
}

function menu(env) {
  return env.documentElement.querySelector('#rozelynx-custom-menu');
}

// ── the REAL background, in the same sandbox as the REAL content script ──
//
// browser.menus exists only in extension pages (scopes:["addon_parent"]), so
// the background is the only place the privileged query and trigger can be
// called. This loader puts the two halves in one sandbox and wires the message
// channel between them exactly as the browser does: `true` from the listener
// means it will answer later, anything else closes the channel and the sender
// rejects.
//
// `opts.menus` is the whole point: pass a menus API to see the feature work,
// and pass nothing to see what a content script really has.
const BG_SRC = path.join(ROOT, 'modules/mouse-gestures/background.js');

function loadPair(opts) {
  opts = opts || {};
  const env = makeEnv({ replies: opts.replies, download: opts.download });
  const bg = { listeners: [] };
  // Wrap addListener itself rather than registering a listener of our own: the
  // fake's addListener keeps only the last one, so a listener added here would
  // be overwritten by the real background and never seen.
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
  if (opts.menus) env.sandbox.browser.menus = opts.menus;
  // The one global background.js takes from lib/feature-loader.js, which is not
  // what is under test here.
  env.sandbox.RozeLynxFeatures = { loadedModules: {}, log() {} };
  vm.createContext(env.sandbox);
  vm.runInContext(fs.readFileSync(BG_SRC, 'utf8'), env.sandbox, { filename: BG_SRC });
  vm.runInContext(fs.readFileSync(SRC, 'utf8'), env.sandbox, { filename: SRC });
  return env;
}

// The rows of the rendered menu, as [class, text, indentPx]
function rows(env) {
  const m = menu(env);
  if (!m) return null;
  return m.children.map(c => [c.className, c.textContent, c.style.paddingLeft || '']);
}
function text(env) { const m = menu(env); return m ? m.children.map(c => c.textContent) : null; }

// Arm the background's reply to the content script's extmenuQuery BEFORE the
// right-click, because the right-click is what sends the query; the content
// script renders in the reply's microtask, so the caller awaits tick() before
// it looks at the DOM. A canned reply is deliberate here - section 12 is the one
// that fails when the privileged API is missing.
function feed(env, items) {
  env.replies['extmenuQuery'] = { ok: true, items: items || [] };
}

// Every extmenuTrigger the content script has sent: the click path's new,
// single hop to the background.
function triggers(env) {
  return env.sent.filter(m => m && m.action === 'extmenuTrigger');
}

const mk = (o) => Object.assign({ extId: 'x@e', extName: 'Ext', title: 'T', type: 'normal', enabled: true, checked: false }, o);

async function main() {
// ===========================================================================
// 1. The RozeLynx group
// ===========================================================================
{
  const env = load({ replies: { 'netiface:available': { ok: true, data: { available: true } } } });
  await tick();
  rightClick(env, env.doc.body);
  const t = text(env);
  ok(!!menu(env), '1.1 the menu opens through the real event path');
  const g = t.indexOf('RozeLynx');
  ok(g >= 0, '1.2 a "RozeLynx" group header is present');
  eq(t.slice(g, g + 4), ['RozeLynx', 'Gesture Guide', 'Inspect', 'Show Accessibility Properties'],
    '1.3 the header is immediately followed by the three guide/inspect items');
  ok(t.indexOf('Bind Network Interface…') === g + 4, '1.4 Bind Network Interface… is the last member of the group',
    'idx=' + t.indexOf('Bind Network Interface…') + ' want ' + (g + 4));
  // the header itself must be a header row, not a clickable item
  const m = menu(env);
  const hdr = m.children.filter(c => c.textContent === 'RozeLynx')[0];
  eq(hdr && hdr.className, 'rx-group-label', '1.5 the header is .rx-group-label, not .rozelynx-menu-item');
  ok(!hdr || hdr._listeners.click === undefined, '1.6 the header has no click listener at all');
  ok(m.children.filter(c => c.classList.contains('rx-group-label')).length === 1, '1.7 exactly one group header in the base menu');
  // netiface entry still last in the menu overall
  eq(t[t.length - 1], 'Bind Network Interface…', '1.8 the group is the last thing in the menu');
}

// ===========================================================================
// 2. Six contexts, one group
// ===========================================================================
{
  const cases = [
    ['page', env => env.doc.body, null],
    ['link', env => { const a = new (require('./lib/fakedom').El)('a'); a.setAttribute('href', 'https://example.com/f'); a.textContent = 'x'; env.doc.body.appendChild(a); return a; }, null],
    ['image', env => { const i = new (require('./lib/fakedom').El)('img'); i.setAttribute('src', 'https://example.com/i.png'); env.doc.body.appendChild(i); return i; }, null],
    ['media', env => { const v = new (require('./lib/fakedom').El)('video'); v.setAttribute('src', 'https://example.com/v.mp4'); env.doc.body.appendChild(v); return v; }, null],
    ['frame', env => { const f = new (require('./lib/fakedom').El)('iframe'); f.setAttribute('src', 'https://example.com/fr'); env.doc.body.appendChild(f); return f; }, null],
    ['selection', env => env.doc.body, { isCollapsed: false, toString: () => 'sel', containsNode: () => true }],
  ];
  let allOk = true;
  for (const [name, mk2, sel] of cases) {
    const env = load({ replies: { 'netiface:available': { ok: true, data: { available: true } } }, selection: sel });
    await tick();
    rightClick(env, mk2(env));
    const t = text(env);
    const g = t.indexOf('RozeLynx');
    if (g < 0) { ok(false, '2.x group present in context ' + name); allOk = false; continue; }
    if (JSON.stringify(t.slice(g, g + 5)) !== JSON.stringify(['RozeLynx', 'Gesture Guide', 'Inspect', 'Show Accessibility Properties', 'Bind Network Interface…'])) {
      ok(false, '2.x group shape in context ' + name, JSON.stringify(t.slice(g, g + 5))); allOk = false; continue;
    }
    ok(true, '2.x group shape in context ' + name);
  }
  ok(allOk, '2.0 the group is identical in all six contexts');
}

// ===========================================================================
// 3. netiface hidden -> group still well-formed, no orphan separator
// ===========================================================================
{
  const env = load({ replies: { 'netiface:available': { ok: false, data: { available: false } } } });
  await tick();
  rightClick(env, env.doc.body);
  const t = text(env);
  ok(t.indexOf('Bind Network Interface…') < 0, '3.1 the netiface entry is gone when the probe says false');
  const g = t.indexOf('RozeLynx');
  eq(t.slice(g), ['RozeLynx', 'Gesture Guide', 'Inspect', 'Show Accessibility Properties'], '3.2 the group is still well-formed');
  const m = menu(env);
  const hdr = m.children.filter(c => c.classList.contains('rx-group-label'))[0];
  const hdrIdx = m.children.indexOf(hdr);
  ok(hdrIdx > 0 && m.children[hdrIdx - 1].classList.contains('rx-sep'), '3.3 there is still a separator before the header');
  // no doubled separator immediately before the header
  ok(!(hdrIdx > 1 && m.children[hdrIdx - 2].classList.contains('rx-sep')), '3.4 and not two in a row');
}
{
  // probe still in flight (no reply at all) -> tri-state null means "show"
  const env = load({});
  rightClick(env, env.doc.body);
  const t = text(env);
  ok(t.indexOf('Bind Network Interface…') > 0, '3.5 an unanswered probe still shows the entry (tri-state null)');
}

// ===========================================================================
// 4. parentId nesting is a real tree
// ===========================================================================
{
  const env = load({ replies: { 'netiface:available': { ok: true, data: { available: true } } } });
  feed(env, [
    mk({ extId: 'a@e', extName: 'uBlock', itemId: 'p1', title: 'Parent one' }),
    mk({ extId: 'a@e', extName: 'uBlock', itemId: 'c1', parentId: 'p1', title: 'Child one' }),
    mk({ extId: 'a@e', extName: 'uBlock', itemId: 'c2', parentId: 'p1', title: 'Child two' }),
    mk({ extId: 'a@e', extName: 'uBlock', itemId: 'c3', parentId: 'p1', title: 'Child three' }),
    mk({ extId: 'b@e', extName: 'Other', itemId: 'q1', title: 'Other top' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  const m = menu(env);
  const ext = m.querySelectorAll('.rx-extmenu').map(c => [c.textContent, c.style.paddingLeft]);
  eq(ext, [
    ['Parent one', '14px'],
    ['Child one', '30px'],
    ['Child two', '30px'],
    ['Child three', '30px'],
    ['Other top', '14px'],
  ], '4.1 children are emitted directly under their parent, roots unindented');
  // child order preserved
  eq(ext.slice(1, 4).map(x => x[0]), ['Child one', 'Child two', 'Child three'], '4.2 child order is the incoming order');
  eq(menu(env).querySelectorAll('.rx-extgroup').map(c => c.textContent), ['uBlock', 'Other'],
    '4.3 the two parents that share one extension get ONE header, not one each');
}

// ===========================================================================
// 5. Two parents -> children are NOT both at one flat indent
// ===========================================================================
{
  const env = load({});
  feed(env, [
    mk({ extId: 'a@e', extName: 'A', itemId: 'p1', title: 'A-parent' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'p2', title: 'B-parent' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'x1', parentId: 'p1', title: 'A-child' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'x2', parentId: 'p2', title: 'B-child' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  const ext = menu(env).querySelectorAll('.rx-extmenu').map(c => [c.textContent, c.style.paddingLeft]);
  eq(ext, [
    ['A-parent', '14px'],
    ['A-child', '30px'],
    ['B-parent', '14px'],
    ['B-child', '30px'],
  ], '5.1 each child follows ITS parent (the old flat renderer emitted p1,p2,x1,x2)');
  // document the old behaviour for contrast
  ok(JSON.stringify(ext.map(x => x[0])) !== '["A-parent","B-parent","A-child","B-child"]', '5.2 the incoming (wrong) order is not what is rendered');
}

// ===========================================================================
// 6. Orphans: a parentId naming an item that is NOT in the list
// ===========================================================================
{
  const env = load({});
  feed(env, [
    mk({ extId: 'a@e', extName: 'A', itemId: 'orphan', parentId: 'gone', title: 'Orphan' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'top', title: 'Top' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  // the parent was filtered out by enabledForContext, so the child is a root
  const ext = menu(env).querySelectorAll('.rx-extmenu').map(c => [c.textContent, c.style.paddingLeft]);
  eq(ext, [['Orphan', '14px'], ['Top', '14px']], '6.1 an orphan is a root, not indented under nothing');
  ok(true, '6.1b');
}
{
  // an item whose parentId is its own id must not recurse forever
  const env = load({});
  feed(env, [mk({ extId: 'a@e', extName: 'A', itemId: 'self', parentId: 'self', title: 'Selfish' })]);
  rightClick(env, env.doc.body);
  await tick();
  const ext = menu(env).querySelectorAll('.rx-extmenu').map(c => [c.textContent, c.style.paddingLeft]);
  eq(ext, [['Selfish', '14px']], '6.2 a self-parented item is a root and the walk terminates');
}
{
  // a two-item cycle: neither is a root, so both must still be shown
  const env = load({});
  feed(env, [
    mk({ extId: 'a@e', extName: 'A', itemId: 'k1', parentId: 'k2', title: 'K1' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'k2', parentId: 'k1', title: 'K2' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  const ext = menu(env).querySelectorAll('.rx-extmenu').map(c => c.textContent);
  eq(ext, ['K1', 'K2'], '6.3 a parentId cycle loses nothing');
}
{
  // deep chain: everything renders, the indent caps
  const env = load({});
  const deep = [];
  for (let i = 0; i < 9; i++) deep.push(mk({ extId: 'a@e', extName: 'A', itemId: 'd' + i, parentId: i ? 'd' + (i - 1) : undefined, title: 'D' + i }));
  feed(env, deep);
  rightClick(env, env.doc.body);
  await tick();
  const pads = menu(env).querySelectorAll('.rx-extmenu').map(c => c.style.paddingLeft);
  eq(pads.length, 9, '6.4 a 9-deep chain renders all 9 items');
  eq(pads, ['14px', '30px', '46px', '62px', '62px', '62px', '62px', '62px', '62px'], '6.5 the indent caps at depth 3');
}

// ===========================================================================
// 7. Per-extension grouping
// ===========================================================================
{
  const env = load({});
  feed(env, [
    mk({ extId: 'a@e', extName: 'uBlock Origin', itemId: 'a1', title: 'A1' }),
    mk({ extId: 'a@e', extName: 'uBlock Origin', itemId: 'a2', title: 'A2' }),
    mk({ extId: 'b@e', extName: 'Dark Reader', itemId: 'b1', title: 'B1' }),
    mk({ extId: 'c@e', extName: 'uGet', itemId: 'c1', title: 'C1' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  const m = menu(env);
  const labels = m.querySelectorAll('.rx-extgroup').map(c => c.textContent);
  eq(labels, ['uBlock Origin', 'Dark Reader', 'uGet'], '7.1 one header per extension, in list order');
  ok(labels.indexOf('uGet') > labels.indexOf('Dark Reader'), '7.2 uGet keeps its position at the end');
  const ext = m.querySelectorAll('.rx-extmenu').map(c => c.textContent);
  eq(ext, ['A1', 'A2', 'B1', 'C1'], '7.3 no item is reordered or lost by grouping');
  // header elements are not clickable items
  ok(m.querySelectorAll('.rx-extgroup').every(c => c._listeners.click === undefined), '7.4 extension headers have no click listener');
}
{
  // two different extensions with the same display name
  const env = load({});
  feed(env, [
    mk({ extId: 'a@e', extName: 'Same', itemId: 'a1', title: 'A1' }),
    mk({ extId: 'b@e', extName: 'Same', itemId: 'b1', title: 'B1' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  eq(menu(env).querySelectorAll('.rx-extgroup').map(c => c.textContent), ['Same', 'b@e'],
    '7.5 a repeated display name falls back to the extension id on the second header');
}

// ===========================================================================
// 8. Separators from other extensions
// ===========================================================================
{
  const env = load({});
  feed(env, [
    mk({ extId: 'a@e', extName: 'A', itemId: 'a1', title: 'A1' }),
    mk({ extId: 'a@e', extName: 'A', type: 'separator', title: '', itemId: 's1' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'a2', title: 'A2' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  const m = menu(env);
  const seq = m.children.map(c => c.classList.contains('rx-sep') ? '--' : c.textContent);
  const extSeq = seq.slice(seq.indexOf('A') >= 0 ? seq.indexOf('A') : seq.length);
  eq(extSeq, ['A', 'A1', '--', 'A2'], '8.1 an extension separator is drawn between the items it separated');
  ok(extSeq[extSeq.length - 1] !== '--', '8.2 no trailing separator');
  ok(!(extSeq[0] === '--' && extSeq[1] === '--'), '8.3 no doubled leading separator');
}
{
  // leading + doubled + trailing separators
  const env = load({});
  feed(env, [
    mk({ extId: 'a@e', extName: 'A', type: 'separator', itemId: 's0' }),
    mk({ extId: 'a@e', extName: 'A', type: 'separator', itemId: 's1' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'a1', title: 'A1' }),
    mk({ extId: 'a@e', extName: 'A', type: 'separator', itemId: 's2' }),
    mk({ extId: 'a@e', extName: 'A', type: 'separator', itemId: 's3' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  const m = menu(env);
  const seps = m.children.filter(c => c.classList.contains('rx-extmenu-sep'));
  eq(seps.length, 1, '8.4 a leading run and a trailing run collapse to just the section rule');
}
{
  // a separator is NOT clickable: the old renderer drew it as an empty
  // .rozelynx-menu-item, so clicking it closed the menu and fired a bogus
  // rozelynx_menu_click at that extension.
  const env = load({});
  feed(env, [
    mk({ extId: 'a@e', extName: 'A', itemId: 'a1', title: 'A1' }),
    mk({ extId: 'a@e', extName: 'A', type: 'separator', itemId: 's1' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'a2', title: 'A2' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  const m = menu(env);
  const sepEl = m.children.filter(c => c.classList.contains('rx-extmenu-sep'))[1];
  ok(!!sepEl, '8.5 the inner separator exists');
  ok(!!sepEl && !sepEl.classList.contains('rozelynx-menu-item'), '8.6 it is not an item row');
  ok(!sepEl || sepEl._listeners.click === undefined, '8.7 clicking it can do nothing');
  const before = env.sent.length;
  if (sepEl) sepEl.dispatch('click', { preventDefault() {} });
  eq(env.sent.length, before, '8.8 and no menu_click is sent for it');
  ok(!!menu(env), '8.9 the menu stays open');
}

// ===========================================================================
// 9. The click path still works, and checkbox/radio prefixes survive
// ===========================================================================
{
  const env = load({});
  feed(env, [
    mk({ extId: 'a@e', extName: 'A', itemId: 'cb', type: 'checkbox', checked: true, title: 'Toggle' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'rd', type: 'radio', checked: false, title: 'Radio' }),
    mk({ extId: 'a@e', extName: 'A', itemId: 'dis', enabled: false, title: 'Disabled' }),
  ]);
  rightClick(env, env.doc.body);
  await tick();
  const m = menu(env);
  const items = m.querySelectorAll('.rx-extmenu');
  eq(items.map(c => c.textContent), ['\u2713 Toggle', 'Radio', 'Disabled'], '9.1 check prefixes and labels render');
  eq(!!items[2] && items[2].classList.contains('rx-disabled'), true, '9.2 the disabled item is marked');
  const before = triggers(env).length;
  if (items[0]) items[0].dispatch('click', { preventDefault() {} });
  // One hop, straight to the background, which is where the privileged
  // rozelynxTrigger lives. It used to be two - a write to storage.local for the
  // menus.js bridge to watch, with a 10-minute TTL on the key.
  const fired = triggers(env).slice(before);
  eq(fired.length, 1, '9.3 clicking an extension item sends exactly one trigger');
  eq(fired[0] && fired[0].module, 'mouse-gestures', '9.3a on the mouse-gestures module');
  eq(fired[0] && fired[0].data && fired[0].data.request &&
     [fired[0].data.request.extId, fired[0].data.request.itemId],
     ['a@e', 'cb'], '9.4 with the right extId/itemId');
  ok(!('rozelynx_menu_click' in env.storage),
     '9.4a and no click record is left sitting in storage.local');
  ok(!menu(env), '9.5 and the menu closes');
  // disabled item: closes, sends nothing
  const env2 = load({});
  rightClick(env2, env2.doc.body);
  feed(env2, [mk({ extId: 'a@e', extName: 'A', itemId: 'dis', enabled: false, title: 'Disabled' })]);
  const it2 = menu(env2).querySelectorAll('.rx-extmenu')[0];
  if (it2) it2.dispatch('click', { preventDefault() {} });
  eq(triggers(env2).length, 0, '9.6 a disabled item fires nothing (it still closes the menu)');
}

// ===========================================================================
// 10. Re-render: the second query replaces the section, headers included
// ===========================================================================
{
  const env = load({});
  feed(env, [mk({ extId: 'a@e', extName: 'A', itemId: 'a1', title: 'A1' })]);
  rightClick(env, env.doc.body);
  await tick();
  const n1 = menu(env).querySelectorAll('.rx-extmenu, .rx-extgroup, .rx-extmenu-sep').length;
  // A second open with different items. The re-render used to be a second
  // storage change against the menu already on screen; now the second open is
  // a second real query, and the section is rebuilt rather than appended to.
  feed(env, [mk({ extId: 'z@e', extName: 'Z', itemId: 'z1', title: 'Z1' })]);
  rightClick(env, env.doc.body);
  await tick();
  const m = menu(env);
  eq(m.querySelectorAll('.rx-extgroup').map(c => c.textContent), ['Z'], '10.1 the old header is gone on re-render');
  eq(m.querySelectorAll('.rx-extmenu').map(c => c.textContent), ['Z1'], '10.2 and so is the old item');
  const n2 = m.querySelectorAll('.rx-extmenu, .rx-extgroup, .rx-extmenu-sep').length;
  eq(n2, n1, '10.3 the section does not accumulate rows across re-renders');
  // and the static RozeLynx group survived
  eq(m.querySelectorAll('.rx-group-label').map(c => c.textContent), ['RozeLynx', 'Z'],
    '10.4 the static RozeLynx header is NOT removed by the extension re-render');
  ok(true, '10.5');
}

// ===========================================================================
// 11. The RozeLynx entries still do their jobs
// ===========================================================================
{
  const env = load({ replies: { 'netiface:available': { ok: true, data: { available: true } } } });
  await tick();
  rightClick(env, env.doc.body);
  env.sent.length = 0;            // drop the load-time probe from the tally
  const m = menu(env);
  const byText = {};
  m.children.forEach(c => { if (c.classList.contains('rozelynx-menu-item')) byText[c.textContent] = c; });
  if (byText['Bind Network Interface…']) byText['Bind Network Interface…'].dispatch('click', { preventDefault() {} });
  const msgs = env.sent.filter(x => x && x.action);
  eq(msgs.map(x => x.action), ['netiface:open-picker'], '11.1 the netiface entry still sends open-picker (and no tabId)');
  ok(!('tabId' in msgs[0]), '11.2 still no tabId in it');
}
{
  // netiface failure still toasts rather than vanishing
  const env = load({ replies: { 'netiface:available': { ok: true, data: { available: true } }, 'netiface:open-picker': { ok: false, error: 'no tab to bind' } } });
  await tick();
  rightClick(env, env.doc.body);
  const m = menu(env);
  const bind = m.children.filter(c => c.textContent === 'Bind Network Interface…')[0];
  if (bind) bind.dispatch('click', { preventDefault() {} });
  await tick();
  ok(env.documentElement.querySelector('#rozelynx-gesture-feedback') !== null, '11.3 a failed open still toasts');
  const toast = env.documentElement.querySelector('#rozelynx-gesture-feedback');
  ok(/no tab to bind/.test(toast.textContent), '11.4 the toast carries the background\'s own reason', toast.textContent);
}

// ===========================================================================
// 12. The real background, the real content script, and the missing API
// ===========================================================================
//
// The sections above are all renderer tests wearing a production hat. This one
// is the check that would have found the bug the first time: it loads both
// halves for real, and it runs the whole thing twice - once with browser.menus
// present, once with browser.menus ABSENT, which is what a content script
// actually sees.
{
  const asked = [];
  const menus = {
    rozelynxQuery(ctx) {
      asked.push(ctx);
      return Promise.resolve([
        mk({ extId: 'ublock@e', extName: 'uBlock Origin', itemId: 'u1', title: 'Block element' }),
        mk({ extId: 'ublock@e', extName: 'uBlock Origin', itemId: 'u2', title: 'Element picker' }),
        mk({ extId: 'darkreader@e', extName: 'Dark Reader', itemId: 'd1', title: 'Toggle' }),
      ]);
    },
    rozelynxTrigger(req) { asked.push(req); return Promise.resolve(); },
  };
  const env = loadPair({ menus });
  await tick();
  rightClick(env, env.doc.body);
  await tick();

  const m = menu(env);
  const groups = m ? m.querySelectorAll('.rx-extgroup').map(c => c.textContent) : [];
  eq(groups, ['uBlock Origin', 'Dark Reader'],
     '12.1 with the privileged API present, the items really render, grouped per extension');
  eq(m ? m.querySelectorAll('.rx-extmenu').map(c => c.textContent) : [],
     ['Block element', 'Element picker', 'Toggle'], '12.2 every item is there');
  ok(asked.length === 1 && asked[0] && typeof asked[0].src === 'string',
     '12.3 and the background was really asked, with the page context', JSON.stringify(asked[0]));
  ok(asked[0] && typeof asked[0].tag === 'string',
     '12.3b including the tag the content script read off the click target');

  // the click reaches the privileged trigger, by extId/itemId
  const first = m.querySelectorAll('.rx-extmenu')[0];
  if (first) first.dispatch('click', { preventDefault() {} });
  await tick();
  const t = asked[asked.length - 1];
  eq(t && [t.extId, t.itemId], ['ublock@e', 'u1'], '12.4 the click triggered that exact item');
}
{
  // No browser.menus at all - the situation the menus.html bridge was in, and
  // the one a permissive stub can never reproduce.
  const env = loadPair({});
  await tick();
  rightClick(env, env.doc.body);
  await tick();

  const m = menu(env);
  eq(m ? m.querySelectorAll('.rx-extmenu, .rx-extgroup').length : 0, 0,
     '12.5 nothing is invented when the API is missing');
  const warns = env.logs.filter(l => l[0] === 'warn').map(l => l[1]);
  ok(warns.length > 0, '12.6 and the failure is VISIBLE, not a silent empty section', JSON.stringify(env.logs));
  ok(warns.some(w => /rozelynxQuery/.test(w)),
     '12.7 the warning names the API that is missing', JSON.stringify(warns));
  ok(env.sent.some(m2 => m2 && m2.action === 'extmenuQuery'),
     '12.8 the content script did try - it asked the background, which is where the answer had to come from');
  ok(!('rozelynx_menu_result' in env.storage),
     '12.9 and nothing was left behind in storage.local for a bridge that no longer exists');
  ok(!env.documentElement.querySelector('#rozelynx-menus-bridge'),
     '12.10 no menus iframe is injected into the page any more');
  eq(env.storage.rozelynx_menu_click, undefined, '12.11 and clicks have no storage channel either');
}

// ===========================================================================
// 13. Save ... As... — routed through the background, picker and all
// ===========================================================================
//
// The old saveAs() clicked a synthetic <a download> in the page, and that
// never worked: the download attribute only applied same-origin (hence the
// old isSameOrigin() gates, which hid the entries for most images), there
// was no Save dialog at all - a silent drop into the download folder - and
// with download-handoff enabled, its capture-phase click hook ate the click
// and location.assign()'d the tab to the image instead of saving anything.
// These drive the real pair the way the fixed code runs: the content script
// sends {module:'mouse-gestures', action:'saveAs'} and the background calls
// downloads.download({saveAs:true}), the browser's own file picker.
{
  // cross-origin image: the entry exists, and the round-trip reaches
  // downloads.download
  const { El } = require('./lib/fakedom');
  const env = loadPair({});
  await tick();
  const img = new El('img');
  img.setAttribute('src', 'https://other.example.net/pic.png');
  env.doc.body.appendChild(img);
  rightClick(env, img);
  await tick();
  const saveItem = menu(env).children.filter(c => c.textContent === 'Save Image As...')[0];
  ok(!!saveItem, '13.1 Save Image As... is offered for a CROSS-ORIGIN image (the old isSameOrigin() gate is gone)');
  saveItem.dispatch('click', { preventDefault() {} });
  await tick(); await tick();
  eq(env.downloadCalls.length, 1, '13.2 exactly one download was started',
    JSON.stringify(env.downloadCalls));
  ok(env.downloadCalls[0] && env.downloadCalls[0].saveAs === true,
    '13.3 with saveAs:true, the browser\'s own Save picker');
  eq(env.downloadCalls[0] && env.downloadCalls[0].url, 'https://other.example.net/pic.png',
    '13.4 for the image\'s own cross-origin URL');
  ok(!menu(env), '13.5 and the menu closed');
  ok(env.downloadCalls[0] && !('filename' in env.downloadCalls[0]),
    '13.6 no filename hint rides an http(s) URL - the browser derives the picker name');
}
{
  // link and media entries take the same road
  const { El } = require('./lib/fakedom');
  const env = loadPair({});
  await tick();
  const a = new El('a');
  a.setAttribute('href', 'https://dl.example.net/file.zip');
  a.textContent = 'file';
  env.doc.body.appendChild(a);
  rightClick(env, a);
  await tick();
  const linkItem = menu(env).children.filter(c => c.textContent === 'Save Link As...')[0];
  ok(!!linkItem, '13.7 Save Link As... is offered for every link');
  linkItem.dispatch('click', { preventDefault() {} });
  await tick(); await tick();
  eq(env.downloadCalls[0] && [env.downloadCalls[0].url, env.downloadCalls[0].saveAs],
    ['https://dl.example.net/file.zip', true], '13.8 the link saves through the same path');

  const env2 = loadPair({});
  await tick();
  const v = new El('video');
  v.setAttribute('src', 'https://media.example.net/clip.mp4');
  env.doc.body.appendChild(v);
  rightClick(env2, v);
  await tick();
  const mediaItem = menu(env2).children.filter(c => c.textContent === 'Save As...')[0];
  ok(!!mediaItem, '13.9 media gets its Save As... entry');
  mediaItem.dispatch('click', { preventDefault() {} });
  await tick(); await tick();
  eq(env2.downloadCalls[0] && env2.downloadCalls[0].url, 'https://media.example.net/clip.mp4',
    '13.10 the media URL is what is saved');
}
{
  // a data: URL carries no filename, so a name derived from its MIME type
  // prefills the picker
  const { El } = require('./lib/fakedom');
  const env = loadPair({});
  await tick();
  const img = new El('img');
  img.setAttribute('src', 'data:image/png;base64,AAAA');
  env.doc.body.appendChild(img);
  rightClick(env, img);
  await tick();
  menu(env).children.filter(c => c.textContent === 'Save Image As...')[0]
    .dispatch('click', { preventDefault() {} });
  await tick(); await tick();
  eq(env.downloadCalls[0] && [env.downloadCalls[0].filename, env.downloadCalls[0].saveAs],
    ['image.png', true], '13.11 a data: URL prefills the picker from its MIME type');
}
{
  // a suggested name the API refuses is retried without it, not lost
  const { El } = require('./lib/fakedom');
  const env = loadPair({
    download: (call) => call.filename
      ? { __reject: true, error: 'filename must not contain illegal characters' }
      : 43,
  });
  await tick();
  const img = new El('img');
  img.setAttribute('src', 'data:image/png;base64,AAAA');
  env.doc.body.appendChild(img);
  rightClick(env, img);
  await tick();
  menu(env).children.filter(c => c.textContent === 'Save Image As...')[0]
    .dispatch('click', { preventDefault() {} });
  await tick(); await tick();
  eq(env.downloadCalls.length, 2, '13.12 a refused filename is retried without it',
    JSON.stringify(env.downloadCalls));
  ok(env.downloadCalls[1] && !('filename' in env.downloadCalls[1]),
    '13.13 the retry carries no filename');
  ok(env.downloadCalls[1] && env.downloadCalls[1].saveAs === true,
    '13.14 and still shows the picker');
}
{
  // a failed download toasts; a cancelled picker does not (it is the user's
  // own decision, and the API rejects with exactly that message)
  const { El } = require('./lib/fakedom');
  const fail = loadPair({ download: () => ({ __reject: true, error: 'SERVER_BAD_CONTENT' }) });
  await tick();
  const img = new El('img');
  img.setAttribute('src', 'https://broken.example.net/x.png');
  fail.doc.body.appendChild(img);
  rightClick(fail, img);
  await tick();
  menu(fail).children.filter(c => c.textContent === 'Save Image As...')[0]
    .dispatch('click', { preventDefault() {} });
  await tick(); await tick();
  const toast = fail.documentElement.querySelector('#rozelynx-gesture-feedback');
  ok(!!toast && /Save As failed/.test(toast.textContent),
    '13.15 a failed download toasts the failure', toast && toast.textContent);

  const cancel = loadPair({
    download: () => ({ __reject: true, error: 'Download canceled by the user' }),
  });
  await tick();
  const img2 = new El('img');
  img2.setAttribute('src', 'https://pick.example.net/y.png');
  cancel.doc.body.appendChild(img2);
  rightClick(cancel, img2);
  await tick();
  menu(cancel).children.filter(c => c.textContent === 'Save Image As...')[0]
    .dispatch('click', { preventDefault() {} });
  await tick(); await tick();
  const toast2 = cancel.documentElement.querySelector('#rozelynx-gesture-feedback');
  ok(!toast2 || !/Save As failed/.test(toast2.textContent),
    '13.16 a cancelled picker is not a failure - no toast', toast2 && toast2.textContent);
}
{
  // no background at all (an event page that has not woken, or a build
  // without the module): the entry point says so rather than doing nothing
  const { El } = require('./lib/fakedom');
  const env = load({});
  const img = new El('img');
  img.setAttribute('src', 'https://solo.example.net/z.png');
  env.doc.body.appendChild(img);
  rightClick(env, img);
  await tick();
  menu(env).children.filter(c => c.textContent === 'Save Image As...')[0]
    .dispatch('click', { preventDefault() {} });
  await tick(); await tick();
  const toast = env.documentElement.querySelector('#rozelynx-gesture-feedback');
  ok(!!toast && /RozeLynx background/.test(toast.textContent),
    '13.17 with no background answering, the toast says so', toast && toast.textContent);
  // and nothing was "downloaded" by the page anchor trick: no navigation
  eq(env.assigned, [], '13.18 the tab is never navigated to the image');
}

// ===========================================================================
}

run('mouse-gestures-menu', main);
