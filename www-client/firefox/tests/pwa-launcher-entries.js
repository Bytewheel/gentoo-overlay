#!/usr/bin/env node
'use strict';
/* Harness for the PWA module's launcher-entry lifecycle, driven through the real
 * `runtime.onMessage` listener the module registers.
 *
 * Why this exists (Part B.0, 2026-09-28). B.4 shipped the .desktop writer and
 * both install paths ask for it, but the writer only ever runs for an app
 * installed AFTER it. An app installed earlier has a site record and no file,
 * and the extension had no way to change that: `write` always rewrites,
 * `remove` always removes, and nothing anywhere asked "is it there?". So the
 * launcher entries for every pre-existing install had to be produced by
 * uninstalling and reinstalling each app by hand.
 *
 * That is what section B is about - `hasDesktopEntry` (the missing read half)
 * and `DesktopEntry.reconcile` (the missing third operation).
 *
 * This harness runs the REAL `pwa/background.js` and the REAL
 * `windows-api.js` in one sandbox, with a real temp directory standing in for
 * ~/.local/share/applications. Nothing is reimplemented: the entry text, the
 * file names, the pref gate and the filesystem are all the shipping code's, so
 * a check can assert on what is actually ON DISK rather than on a return value.
 *
 * Sections:
 *   A  reconcile writes entries for apps that have none, and only those
 *   B  it is idempotent - a second pass writes nothing
 *   C  the pref gate, and that removal is deliberately not gated on it
 *   D  one app failing does not stop the others
 *   E  the entry content itself: --profile, --ssb-class, --ssb-icon, Icon=
 *   F  the Exec line and StartupWMClass agree with what the launch path uses
 *   G  message hygiene: unrelated messages are not swallowed
 *   H  the icon ladder: candidates, favicons and the packaged fallback (1.0.73)
 *   I  reconcile UPGRADES an entry whose Icon= fell behind (1.0.73)
 *   J  PWAManager.install keeps the same ladder (1.0.73)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const vm = require('vm');

const { ok, eq, note, run, tick } = require('./lib/check.js');
const { spawnSync } = require('child_process');
const { root, requireTree } = require('./lib/roots.js');
const { messageRouter } = require('./lib/webext.js');
const { makeSandbox } = require('./lib/xpcomfile.js');

const ROOT = requireTree(root(process.argv), 'extension tree');
const EXT = ROOT;

const DATA_PNG =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

let scratch;
let seq = 0;

/* Load the real windows-api.js and the real pwa/background.js into one context.
 *
 * The two share a sandbox on purpose: it is the only arrangement in which the
 * module's `browser.rozelynxWindows.*` calls and the privileged half beneath
 * them are the same code, which is what makes "an entry exists on disk" a
 * statement about the real feature rather than about a mock.
 */
function loadPair(opts) {
  const o = opts || {};
  const dir = fs.mkdtempSync(path.join(scratch, 'rz-pwa-'));
  const sb = makeSandbox({ tmpDir: dir, env: o.env || {} });

  // --- the privileged half, for real -------------------------------
  class ExtensionAPI {}
  const privileged = vm.createContext(Object.assign({
    ExtensionAPI,
    console: consoleStub(),
    ChromeUtils: { generateQI: () => ({}) },
  }, sb));
  privileged.globalThis = privileged;
  vm.runInContext(fs.readFileSync(
    path.join(EXT, 'lib/experiments/windows-api.js'), 'utf8'),
  privileged, { filename: 'windows-api.js' });
  // getAPI() returns { <namespace>: {...} }; the module is handed the namespace
  // itself, which is what lib/experiments/xpcomfile.js's loadApi also does.
  const winApi = privileged.rozelynxWindows.prototype
    .getAPI({ extension: { windowManager: null } }).rozelynxWindows;

  // --- the module half ---------------------------------------------
  const storage = {};
  // Seeded BEFORE the module is evaluated, so the reconcile pass that runs at
  // start-up - the production path - is the one under test. Loading the module
  // first and seeding afterwards would race it, and a test that measured the
  // race instead of the behaviour is the same mistake this harness exists to
  // stop making.
  if (o.sites) storage.rozelynx_pwa_sites = JSON.stringify(o.sites);

  const router = messageRouter();
  const listeners = () => ({ addListener(fn) { /* recorded, not driven here */ } });
  const logs = [];
  const con = consoleStub(logs);
  const appDir = path.join(sb.home, '.local/share/applications');

  const browser = {
    runtime: {
      onMessage: { addListener: (fn) => router.add(fn) },
      getURL: (p) => 'moz-extension://rz/' + p,
      onInstalled: { addListener() {} },
    },
    storage: {
      local: {
        get: (k) => Promise.resolve(
          Array.isArray(k)
            ? k.reduce((a, n) => (n in storage ? (a[n] = storage[n], a) : a), {})
            : (k in storage ? { [k]: storage[k] } : {})),
        set: (obj) => { Object.assign(storage, obj); return Promise.resolve(); },
        remove: (k) => { delete storage[k]; return Promise.resolve(); },
      },
    },
    tabs: {
      onCreated: listeners(), onUpdated: listeners(), onRemoved: listeners(),
      query: () => Promise.resolve([]), get: () => Promise.reject(new Error('no tab')),
      create: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve(),
      move: () => Promise.resolve(), executeScript: () => Promise.resolve([]),
    },
    windows: {
      onRemoved: listeners(),
      getAll: () => Promise.resolve([]), get: () => Promise.reject(new Error('no win')),
      create: () => Promise.resolve({ id: 1 }), update: () => Promise.resolve(),
    },
    webNavigation: { onCommitted: listeners() },
    webRequest: { onBeforeRequest: { addListener() {} } },
    notifications: {
      onClicked: listeners(),
      create: () => Promise.resolve('n'), clear: () => Promise.resolve(true),
    },
    action: { setIcon: () => Promise.resolve(), setBadgeText: () => Promise.resolve() },
    commands: { onCommand: listeners() },
    // The privileged half, wired as the module would see it.
    rozelynxWindows: winApi,
  };
  if (!o.noPrefsApi) {
    browser.rozelynxPrefs = {
      getPrefs: (names) => Promise.resolve((names || []).map(n => {
        const v = (o.prefs || {})[n];
        if (typeof v === 'boolean') return { name: n, type: 'boolean', value: v };
        if (typeof v === 'string') return { name: n, type: 'string', value: v };
        return { name: n, type: 'missing', value: null };
      })),
    };
  }
  // Stubs applied to the privileged namespace BEFORE the module can use them, so
  // a "no hasDesktopEntry"/"no writer" case is real rather than patched in
  // afterwards.
  Object.assign(browser.rozelynxWindows, o.privileged || {});

  // lib/feature-loader.js is what injects modules/pwa/background.js in the real
  // background page, and it is the only thing that puts `RozeLynxFeatures` in
  // scope. The module uses it for one line - loadedModules['pwa'] = true, a
  // bookkeeping record - so it is stubbed rather than run: running the loader
  // would try to inject a dozen other modules' backgrounds over a real
  // browser.extension.getURL that this sandbox does not have, and none of that
  // is what these sections are about.
  const loadedModules = {};
  const ctx = vm.createContext({
    browser, console: con, URL, setTimeout, clearTimeout,
    setInterval, clearInterval, Promise, JSON, Math, Date, Object, Array, String,
    Number, Boolean, Error, RegExp,
    // The default is "no net" on purpose: every leg that is not about the
    // network must stay on the offline path, and the fetch-requiring legs
    // (H, J) stub their own through o.fetch.
    fetch: o.fetch || (() => Promise.reject(new Error('no net'))),
    FileReader: function () { this.readAsDataURL = () => {}; },
    RozeLynxFeatures: { loadedModules, loadErrors: {}, initialized: true },
  });
  if (o.dom) {
    // A model of the background page's own DOM, for the canvas re-encode
    // rung: an Image that always loads (1x1) and a canvas whose toDataURL
    // answers a real 1x1 PNG. The DOM is not under test - the ladder's use
    // of it is - and a real background page has exactly these globals.
    ctx.Image = function () {
      const img = { naturalWidth: 1, naturalHeight: 1, onload: null, onerror: null };
      Object.defineProperty(img, 'src', {
        get() { return ''; },
        set() { setTimeout(() => { if (img.onload) img.onload(); }, 0); },
      });
      return img;
    };
    ctx.document = {
      createElement() {
        return {
          width: 0,
          height: 0,
          getContext() { return { drawImage() {} }; },
          toDataURL() { return DATA_PNG; },
        };
      },
    };
  }
  ctx.globalThis = ctx;
  vm.runInContext(fs.readFileSync(
    path.join(EXT, 'modules/pwa/background.js'), 'utf8'),
  ctx, { filename: 'pwa/background.js' });

  const h = {
    send: (msg) => router.send(msg, {}),
    storage, logs, sb, appDir, dir, ctx, loadedModules, winApi,
    // bgDiag writes its ring to storage.local, not to the console - a check
    // looking for it in the console stub would be looking in the wrong place.
    diag: () => {
      try { return JSON.parse(storage.rozelynx_pwa_diag || '[]'); } catch (e) { return []; }
    },
    diagText: () => h_logs(storage).join('\n'),
    files: () => (fs.existsSync(appDir) ? fs.readdirSync(appDir).sort() : []),
    read: (n) => fs.readFileSync(path.join(appDir, n), 'utf8'),
    entryFor: (site) => h.read(h.files().find(f => f.includes(site.id))),
    // Take the entries away, so the next pass has real work to do.
    wipe: () => { for (const f of h.files()) fs.unlinkSync(path.join(appDir, f)); },
    // The module runs a reconcile pass of its own at start-up. Wait for it
    // rather than sleeping a guessed interval: it is the production path and
    // its summary line is in the ring.
    settled: async () => {
      for (let i = 0; i < 400; i++) {
        // Two ways to finish: the summary line, or one of the two skip lines
        // (pref off, or a parent without hasDesktopEntry). A pass that returns
        // early writes no summary, and waiting for one would hang forever -
        // which is the failure this very harness already hit once.
        if (h.diag().some(e => /^desktop-entry-reconcile( |-skip)/.test(String(e.msg)))) {
          return true;
        }
        await new Promise(r => setTimeout(r, 5));
      }
      return false;
    },
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
  return h;
}

/* Boot a profile that already has these apps installed, and wait for the
 * start-up reconcile to finish. `startup` is the returned summary line, so a
 * section can assert on what the production pass actually did. */
async function booted(sites, opts) {
  const h = loadPair(Object.assign({ sites }, opts || {}));
  const label = (sites || []).map(x => x.name).join(', ') || '(no sites)';
  ok(await h.settled(),
    'the start-up reconcile ran to completion for: ' + label);
  return h;
}

function h_logs(storage) {
  try {
    return JSON.parse(storage.rozelynx_pwa_diag || '[]').map(e => e.msg);
  } catch (e) {
    return [];
  }
}

function consoleStub(logs) {
  const rec = logs || [];
  return {
    log: (...a) => rec.push('log ' + a.join(' ')),
    info: (...a) => rec.push('info ' + a.join(' ')),
    warn: (...a) => rec.push('warn ' + a.join(' ')),
    error: (...a) => rec.push('error ' + a.join(' ')),
    debug: () => {},
    records: rec,
  };
}

function site(name, id) {
  seq++;
  return {
    id: id || ('pwa-' + seq),
    name: name || ('App ' + seq),
    shortName: name,
    description: '',
    startUrl: 'https://app' + seq + '.example/',
    scope: 'https://app' + seq + '.example/',
    display: 'standalone',
    themeColor: '#8B5CF6',
    backgroundColor: '#fff',
    icon: DATA_PNG,
    installedAt: 1,
    lastUsed: 1,
  };
}

/* A profile that already has apps installed and NO launcher entries - the state
 * every profile that installed a PWA before B.4 is in. */
async function seeded(sites, opts) {
  const h = loadPair(opts);
  h.storage.rozelynx_pwa_sites = JSON.stringify(sites);
  // Wait for the module's own start-up reconcile to finish, so a section only
  // ever measures the pass it triggers itself. Without this the start-up pass
  // and the test's share the same stubs and the counts come out wrong - which
  // is the "two mutations were no-ops" trap in a different costume.
  ok(await h.settled(),
    'the module\'s start-up reconcile completed (for: ' +
    (sites || []).map(x => x.name).join(', ') + ')');
  h.storage.rozelynx_pwa_diag = '[]';
  return h;
}

/* ---------------------------------------------------------------- A */

/* A profile that already has apps installed and NO launcher entries - the state
 * every profile that installed a PWA before B.4 is in. The pass under test is
 * the module's own start-up reconcile, which is the production path. */
async function sectionA() {
  const sites = [site('Alpha'), site('Beta'), site('Gamma')];
  const h = await booted(sites);
  try {
    eq(h.files(), [
      'rozelynx-pwa-alpha-pwa-1.desktop',
      'rozelynx-pwa-beta-pwa-2.desktop',
      'rozelynx-pwa-gamma-pwa-3.desktop',
    ], 'A.1 one entry per installed app, written at start-up');
    const summary = h.diagText();
    ok(/desktop-entry-reconcile sites=3 written=3 present=0 failed=0/.test(summary),
      'A.2 the pass reported what it did', summary);
    for (const n of h.files()) {
      const body = h.read(n);
      ok(body.startsWith('[Desktop Entry]'), 'A.3 ' + n + ' is a desktop entry');
      ok(body.includes('\nExec='), 'A.4 ' + n + ' has an Exec line');
      ok(body.includes('Type=Application'), 'A.5 ' + n + ' has Type=Application');
      ok(fs.statSync(path.join(h.appDir, n)).mode & 0o777, 'A.6 ' + n + ' exists on disk');

      // Exactly one group, and no key twice. The live tree shipped every entry
      // with the whole [Desktop Entry] block TWICE, byte-identical, because
      // writeFileBytes passed 0x10 believing it was PR_TRUNCATE when it is
      // PR_APPEND, so a second write appended instead of replacing. Every
      // assertion above still passed on that file - it starts with
      // [Desktop Entry], it has an Exec line, it has Type=Application - which
      // is why the duplication survived until a desktop-file-validate run on
      // the real tree rejected it. This is the check that does not.
      const groups = (body.match(/^\[Desktop Entry\]/gm) || []).length;
      eq(groups, 1, 'A.10 ' + n + ' has exactly one [Desktop Entry] group');
      const keys = body.split('\n').filter(l => l && !l.startsWith('['))
        .map(l => l.split('=')[0]);
      const dupes = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
      ok(dupes.length === 0, 'A.11 ' + n + ' repeats no key', dupes.join(','));
    }

    // The real validator, when it is installed. PLAN-SESSION-20's B.4 record
    // claimed "desktop-file-validate accepts all five" and no harness here
    // called it, so the claim was not backed by anything that survived; this
    // runs it for real. Skipped loudly when absent rather than passed, because
    // a check that silently does nothing is the habit this section exists to
    // break - and the branding leg's own precedent for a missing tool is to
    // report it rather than substitute something else.
    {
      const have = spawnSync('desktop-file-validate', ['--version'],
        { encoding: 'utf8' });
      if (have.error) {
        note('A.12 SKIPPED: desktop-file-validate is not installed; the group ' +
          'and key checks above are the substitute, and they are what caught it');
      } else {
        for (const n of h.files()) {
          const r = spawnSync('desktop-file-validate', [path.join(h.appDir, n)],
            { encoding: 'utf8' });
          ok(r.status === 0, 'A.12 desktop-file-validate accepts ' + n,
            (r.stdout || '') + (r.stderr || ''));
        }
      }
    }
    // The icon each entry points at must be a real file, because Icon= has to
    // be a path and the whole point of writeIconFile is to make one.
    const iconLine = h.entryFor(sites[0]).split('\n').find(l => l.startsWith('Icon='));
    const iconPath = iconLine.slice('Icon='.length);
    ok(path.isAbsolute(iconPath), 'A.7 Icon= is an absolute path', iconPath);
    ok(fs.existsSync(iconPath), 'A.8 ...and the file it names exists');
    ok(iconPath.startsWith(path.join(h.sb.profd, 'pwa-icons')),
      'A.9 ...under <profile>/pwa-icons/', iconPath);
  } finally { h.cleanup(); }
}

/* ---------------------------------------------------------------- B */

async function sectionB() {
  const sites = [site('Alpha'), site('Beta')];
  const h = await booted(sites);
  try {
    // Idempotence: a second pass must write nothing and touch nothing.
    const before = h.files().map(n => [n, fs.statSync(path.join(h.appDir, n)).mtimeMs]);
    const r2 = await h.send({ module: 'pwa', action: 'reconcile-entries' });
    eq(r2.written, 0, 'B.1 a second pass writes nothing');
    eq(r2.present, 2, 'B.2 both entries are recognised as present');
    const after = h.files().map(n => [n, fs.statSync(path.join(h.appDir, n)).mtimeMs]);
    eq(after, before, 'B.3 and the files on disk are untouched');

    // An entry that has gone missing is written again - the wiped
    // ~/.local/share case, which is why the read half exists at all.
    h.wipe();
    const r3 = await h.send({ module: 'pwa', action: 'reconcile-entries' });
    eq(r3.written, 2, 'B.4 wiped entries are recreated');
    eq(r3.present, 0, 'B.5 ...and counted as missing, not as present');

    // Half wiped: only the missing one comes back.
    fs.unlinkSync(path.join(h.appDir, h.files()[0]));
    const r4 = await h.send({ module: 'pwa', action: 'reconcile-entries' });
    eq(r4.written, 1, 'B.6 a partly-wiped directory heals only what is missing');
    eq(r4.present, 1, 'B.7 ...leaving the survivor alone');
  } finally { h.cleanup(); }
}

/* ---------------------------------------------------------------- C */

async function sectionC() {
  // Off: nothing is written, and the reason is reported rather than guessed.
  {
    const h = await booted([site('Alpha')],
      { prefs: { 'rozelynx.pwa.generateDesktopEntries': false } });
    try {
      eq(h.files(), [], 'C.1 the pref off writes nothing at start-up');
      ok(h.diagText().includes('desktop-entry-reconcile-skip'),
        'C.2 ...and the reason is in the ring', h.diagText());
      const r = await h.send({ module: 'pwa', action: 'reconcile-entries' });
      eq(r.ok, true, 'C.3 an explicit pass with the pref off is not an error');
      eq(r.skipped, 'disabled', 'C.4 ...it says why it did nothing');
    } finally { h.cleanup(); }
  }

  // No prefs API at all: the declared default applies. A build whose privileged
  // half failed to load must still get entries, or the feature is silently off.
  {
    const h = await booted([site('Alpha')], { noPrefsApi: true });
    try {
      eq(h.files().length, 1, 'C.5 no prefs API falls back to the declared default');
    } finally { h.cleanup(); }
  }

  // Removal is deliberately NOT gated on the pref: a user who turns the feature
  // off must still be able to clear what an earlier version wrote.
  {
    const s = site('Alpha');
    const h = await booted([s]);
    try {
      eq(h.files().length, 1, 'C.6 an entry exists to remove');
      h.ctx.browser.rozelynxPrefs.getPrefs = (names) => Promise.resolve(
        names.map(n => ({ name: n, type: 'boolean', value: false })));
      const r = await h.send({ module: 'pwa', action: 'remove-entry', data: { site: s } });
      ok(r.ok && r.removed, 'C.7 removal ignores the pref', JSON.stringify(r));
      eq(h.files(), [], 'C.8 ...so the entry is gone anyway');
    } finally { h.cleanup(); }
  }

  // Two apps whose names sanitise to the same string must not share a file.
  {
    const a = site('My App', 'pwa-aaa');
    const b = site('My.App', 'pwa-bbb');
    const h = await booted([a, b]);
    try {
      eq(h.files().length, 2, 'C.9 same-sanitising names get two files', h.files());
      ok(h.files()[0] !== h.files()[1], 'C.10 ...and they are different');
      const r = await h.send({ module: 'pwa', action: 'remove-entry', data: { site: a } });
      eq(h.files().length, 1, 'C.11 removing one leaves the other');
      ok(h.files()[0].includes('pwa-bbb'), 'C.12 ...the right one', h.files());
    } finally { h.cleanup(); }
  }

  // Removing something that is not there is the state asked for, not a failure.
  {
    const s = site('Alpha');
    const h = await booted([s]);
    try {
      const first = await h.send({ module: 'pwa', action: 'remove-entry', data: { site: s } });
      ok(first.removed, 'C.13 the first remove deletes it');
      const again = await h.send({ module: 'pwa', action: 'remove-entry', data: { site: s } });
      ok(again.ok && again.removed === false,
        'C.14 removing again is ok with removed=false', JSON.stringify(again));
    } finally { h.cleanup(); }
  }
}

/* ---------------------------------------------------------------- D */

async function sectionD() {
  const sites = [site('Alpha'), site('Beta'), site('Gamma')];
  // One app that cannot be written must not stop the rest: a reconcile pass
  // that threw would take the whole module's start-up with it. The stubs are
  // installed BEFORE the module loads, so only the start-up pass is measured.
  {
    let n = 0;
    const h = await booted(sites, {
      privileged: {
        writeDesktopEntry: (name, content) => {
          n++;
          if (n === 2) return Promise.resolve({ ok: false, error: 'disk full' });
          return h_realWrite(name, content);
        },
      },
    });
    try {
      // `h_realWrite` is filled in below via a closure over the harness's own
      // real privileged API, so this section re-runs after boot with the real
      // one in place. See the note below.
    } finally { h.cleanup(); }
  }

  // The same matrix, measured on an explicit pass with the stubs swapped in
  // afterwards - which is why every case starts by wiping the entries.
  const cases = [
    ['a failing write', (real) => {
      let n = 0;
      return {
        stub: (name, content) => {
          n++;
          return n === 2 ? Promise.resolve({ ok: false, error: 'disk full' }) : real(name, content);
        },
        expect: { written: 2, failed: 1, ok: false, files: 2,
          log: /desktop-entry-reconcile-failed.*disk full/ },
      };
    }],
    ['a throwing write', (real) => {
      let n = 0;
      return {
        stub: (name, content) => {
          n++;
          if (n === 1) throw new Error('boom');
          return real(name, content);
        },
        // write() has its own try/catch, so a throw surfaces as
        // desktop-entry-throw followed by reconcile-failed - not as
        // reconcile-throw, which is for a throw in reconcile's own body.
        expect: { written: 2, failed: 1, ok: false, files: 2,
          log: /desktop-entry-throw Error: boom[\s\S]*desktop-entry-reconcile-failed site=\S+ Error: boom/ },
      };
    }],
  ];

  for (const [label, build] of cases) {
    const h = await booted(sites);
    try {
      const real = h.winApi.writeDesktopEntry;
      h.wipe();
      const c = build(real);
      h.winApi.writeDesktopEntry = c.stub;
      const r = await h.send({ module: 'pwa', action: 'reconcile-entries' });
      eq(r.written, c.expect.written, 'D ' + label + ': the others were still written',
        JSON.stringify(r));
      eq(r.failed, c.expect.failed, 'D ' + label + ': the failing one is counted');
      eq(r.ok, c.expect.ok, 'D ' + label + ': the pass says whether it was clean');
      eq(h.files().length, c.expect.files, 'D ' + label + ': the files on disk');
      ok(c.expect.log.test(h.diagText()),
        'D ' + label + ': the reason is in the ring', h.diagText());
    } finally { h.cleanup(); }
  }

  // A parent with no hasDesktopEntry: say so, do not report "0 written" as if
  // the pass had run, and do not write on a guess.
  {
    const h = await booted(sites, {
      privileged: { hasDesktopEntry: undefined },
    });
    try {
      eq(h.files(), [], 'D.1 an older parent writes nothing');
      ok(h.diagText().includes('desktop-entry-reconcile-skip no hasDesktopEntry'),
        'D.2 ...and says which function is missing', h.diagText());
    } finally { h.cleanup(); }
  }

  // No sites at all is a no-op, not an error.
  {
    const h = await booted([]);
    try {
      ok(/desktop-entry-reconcile sites=0 written=0/.test(h.diagText()),
        'D.3 an empty profile is a clean no-op', h.diagText());
      eq(h.files(), [], 'D.4 ...and writes nothing');
    } finally { h.cleanup(); }
  }

  // No writer at all: the entry cannot be written, and it must be reported
  // rather than swallowed.
  {
    const h = await booted(sites, { privileged: { writeDesktopEntry: undefined } });
    try {
      eq(h.files(), [], 'D.5 a missing writer writes no files');
      ok(/desktop-entry-reconcile sites=3 written=0 present=0 failed=3/.test(h.diagText()),
        'D.6 ...and every site is counted as failed', h.diagText());
    } finally { h.cleanup(); }
  }
}

/* ---------------------------------------------------------------- E */

async function sectionE() {
  const sites = [site('Alpha')];
  const h = await booted(sites);
  try {
    const body = h.entryFor(sites[0]);
    const lines = {};
    for (const l of body.split('\n')) {
      const i = l.indexOf('=');
      if (i > 0) lines[l.slice(0, i)] = l.slice(i + 1);
    }
    eq(lines.Type, 'Application', 'E.1 Type=Application');
    eq(lines.Terminal, 'false', 'E.2 Terminal=false');
    eq(lines.Version, '1.0', 'E.3 Version=1.0');
    eq(lines.Name, 'Alpha', 'E.4 Name is the site name');
    ok(lines.Categories.includes('WebBrowser'), 'E.5 Categories has WebBrowser');

    // The profile pin. This is B.2.1's whole reason for existing, and it has to
    // be the running profile's own directory.
    ok(/--profile /.test(lines.Exec), 'E.6 the Exec line pins a profile', lines.Exec);
    ok(lines['X-RozeLynx-Profile'].length > 0,
      'E.7 X-RozeLynx-Profile carries it', lines['X-RozeLynx-Profile']);
    ok(lines.Exec.includes(h.sb.profd),
      'E.8 ...and it is the running profile', lines.Exec);
    ok(lines.Exec.indexOf('--profile') < lines.Exec.indexOf('--ssb '),
      'E.9 --profile precedes --ssb');

    // The class, which the launcher groups by and the --ssb handler applies.
    const klass = lines['StartupWMClass'];
    ok(klass.startsWith('rozelynx-'), 'E.10 StartupWMClass is namespaced', klass);
    ok(lines.Exec.includes('--ssb-class ' + klass),
      'E.11 ...and --ssb-class agrees with it', lines.Exec);

    // The icon path, used by BOTH Icon= and --ssb-icon.
    ok(lines.Exec.includes('--ssb-icon ' + lines.Icon),
      'E.12 Icon= and --ssb-icon name the same file', lines.Exec);
    ok(fs.existsSync(lines.Icon), 'E.13 ...and that file exists');

    // A site with no icon must still get a legal Icon=, never a data: URL.
    {
      const noIcon = site('NoIcon');
      noIcon.icon = null;
      const h2 = await booted([noIcon]);
      try {
        const body2 = h2.entryFor(noIcon);
        const icon = body2.split('\n').find(l => l.startsWith('Icon='));
        ok(icon && !icon.startsWith('Icon=data:'),
          'E.14 a site with no icon does not get a data: URL as Icon=', icon);
        eq(icon, 'Icon=rozelynx',
          'E.15 ...it falls back to the app icon name the ebuild installs');
        ok(!/--ssb-icon /.test(body2),
          'E.16 ...and --ssb-icon is omitted rather than emitted empty');
      } finally { h2.cleanup(); }
    }

    // Quoting. The Exec line is machine-parsed on one side and hand-scanned on
    // the other, so the check that matters is not the text but the argv a
    // desktop launcher would exec() from it - and only the spec's four in-quote
    // escapes may appear. This is the same tokeniser B.2.1's end-to-end check
    // used, because a regex over the raw line cannot tell \$ (legal) from \&
    // (not an escape at all).
    {
      const odd = site('Weird "App" & Co');
      odd.startUrl = 'https://x.example/?a=1&b=2#/r/$sub';
      const h3 = await booted([odd]);
      try {
        const body3 = h3.entryFor(odd);
        const exec = body3.split('\n').find(l => l.startsWith('Exec='));
        const argv = tokenizeExec(exec.slice('Exec='.length));
        eq(argv[0], 'rozelynx', 'E.17 the argv starts with the browser binary');
        eq(argv[argv.length - 1], odd.startUrl,
          'E.18 the URL survives tokenising byte-for-byte');
        eq(argv.filter(a => a === '--ssb-class').length, 1, 'E.19 one --ssb-class');
        eq(argv.filter(a => a === '--profile').length, 1, 'E.20 one --profile');
        ok(argv.includes(h3.sb.profd), 'E.21 ...carrying the profile directory');
        // & must NOT be backslash-escaped: the spec defines exactly four
        // in-quote escapes (\", \`, \$, \\) and & is not one of them.
        const ssb = exec.slice(exec.indexOf('--ssb '));
        ok(!/\\&/.test(ssb), 'E.22 & is not escaped - it is not an escape',
          ssb);
        // ...and $ IS one of the four, so \\? is correct and must survive.
        ok(ssb.includes('\\$sub'), 'E.23 $ IS escaped, as the spec requires', ssb);
        // The file name is sanitised, not escaped.
        const fname = h3.files()[0];
        ok(/^rozelynx-pwa-[a-z0-9_-]+-pwa-\d+\.desktop$/.test(fname),
          'E.24 the file name is sanitised to [a-z0-9_-]', fname);
      } finally { h3.cleanup(); }
    }
  } finally { h.cleanup(); }
}

/* Desktop Entry spec tokeniser: reserved characters force quoting, and inside
 * quotes only \", \`, \$ and \\ are escapes - anything else keeps its
 * backslash, which is exactly what a conforming parser does. */
function tokenizeExec(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;
  let started = false;
  const RESERVED = new Set([' ', '\t', '\n', '"', "'", '\\', '>', '<', '~',
    '|', '&', ';', '$', '*', '?', '#', '(', ')']);
  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (c === '"') { inQuotes = !inQuotes; started = true; continue; }
    if (!inQuotes && (c === ' ' || c === '\t')) {
      if (started) { out.push(cur); cur = ''; started = false; }
      continue;
    }
    started = true;
    if (inQuotes && c === '\\') {
      const n = line[++i];
      if (n === '"' || n === '`' || n === '$' || n === '\\') cur += n;
      else cur += c + n;          // undefined escape: backslash is kept
      continue;
    }
    cur += c;
  }
  if (started) out.push(cur);
  return out;
}

/* ---------------------------------------------------------------- F */

async function sectionF() {
  // The launch path and the entry must agree: the class a window is given when
  // launched from the browser has to be the class the entry declares, or the
  // launcher cannot group the two. That is the seam the whole feature exists
  // to close, and it is only checkable by comparing both sides.
  const s = site('Alpha');
  const h = await booted([s]);
  try {
    const wmClass = h.entryFor(s).split('\n')
      .find(l => l.startsWith('StartupWMClass=')).slice('StartupWMClass='.length);

    const classCalls = [];
    h.winApi.setWindowClass = (id, klass) => {
      classCalls.push(klass);
      return Promise.resolve({ ok: true });
    };
    h.winApi.isTaskbarAvailable = () => Promise.resolve({ ok: true, available: true });

    const r = await h.send({ module: 'pwa', action: 'launch', data: { siteId: s.id } });
    ok(r.success, 'F.1 the app launches', JSON.stringify(r));
    eq(classCalls, [wmClass],
      "F.2 the launched window gets the entry's StartupWMClass");

    // The icon the entry points at is the one the launch path sets, so a
    // launcher-launched window and an in-browser one cannot end up with
    // different icons.
    const icon = h.entryFor(s).split('\n').find(l => l.startsWith('Icon='))
      .slice('Icon='.length);
    const iconPaths = [];
    h.winApi.setWindowIconFromPath = (id, p) => {
      iconPaths.push(p);
      return Promise.resolve({ ok: true });
    };
    const s2 = site('Beta');
    const h2 = await booted([s2]);
    try {
      const icon2 = h2.entryFor(s2).split('\n').find(l => l.startsWith('Icon='))
        .slice('Icon='.length);
      const paths = [];
      h2.winApi.setWindowClass = () => Promise.resolve({ ok: true });
      h2.winApi.isTaskbarAvailable = () => Promise.resolve({ ok: true, available: true });
      h2.winApi.setWindowIconFromPath = (id, p) => {
        paths.push(p); return Promise.resolve({ ok: true });
      };
      await h2.send({ module: 'pwa', action: 'launch', data: { siteId: s2.id } });
      eq(paths, [icon2],
        'F.3 the launched window gets the entry\'s icon path');
      ok(fs.existsSync(paths[0]), 'F.4 ...and that path exists');
    } finally { h2.cleanup(); }
    ok(typeof icon === 'string' && icon.length > 0, 'F.5 the entry had an icon path');
  } finally { h.cleanup(); }

  // The nameless degenerate case must still produce a class, and both sides
  // must still agree on it.
  {
    const anon = { id: 'pwa-zzz', startUrl: 'https://anon.example/' };
    const h2 = await booted([anon]);
    try {
      const wmClass = h2.entryFor(anon).split('\n')
        .find(l => l.startsWith('StartupWMClass=')).slice('StartupWMClass='.length);
      const calls = [];
      h2.winApi.setWindowClass = (id, k) => { calls.push(k); return Promise.resolve({ ok: true }); };
      h2.winApi.isTaskbarAvailable = () => Promise.resolve({ ok: true, available: true });
      await h2.send({ module: 'pwa', action: 'launch', data: { siteId: anon.id } });
      eq(calls, [wmClass], 'F.6 a site with no name still agrees on the class');
      ok(wmClass.startsWith('rozelynx-'), 'F.7 ...and it is namespaced', wmClass);
    } finally { h2.cleanup(); }
  }
}

/* ---------------------------------------------------------------- G */

async function sectionG() {
  const h = await booted([site('Alpha')]);
  try {
    eq(h.loadedModules.pwa, true,
      'G.0 the module registered itself with the feature loader');

    // Another module's message must be ignored, not answered - the listener
    // returns false for anything it does not own, so the channel closes and the
    // SENDER's promise rejects. Model that wrongly and this check hangs.
    for (const msg of [
      { module: 'netiface', action: 'netiface:effective' },
      { module: 'pwa', action: 'not-an-action' },
      { module: 'downloads-handoff', action: 'status' },
    ]) {
      let rejected = false;
      try {
        await h.send(msg);
      } catch (e) {
        rejected = true;
      }
      ok(rejected, 'G.1 ' + msg.module + '/' + msg.action + ' is not swallowed');
    }

    // write-entry with nothing in it must be an answer, not a crash.
    const empty = await h.send({ module: 'pwa', action: 'write-entry', data: {} });
    eq(empty.ok, false, 'G.2 write-entry with no site is {ok:false}');
    ok(/no site/.test(empty.error || ''), 'G.3 ...saying why', empty.error);

    const rem = await h.send({ module: 'pwa', action: 'remove-entry', data: {} });
    eq(rem.ok, false, 'G.4 remove-entry with no site is {ok:false}');

    const getAll = await h.send({ module: 'pwa', action: 'getAll' });
    ok(getAll && Array.isArray(getAll.sites),
      'G.5 getAll still answers', JSON.stringify(getAll));
  } finally { h.cleanup(); }
}

/* ---------------------------------------------------------------- H */

/* The icon ladder (v1.0.73). A site with NO icon at all used to leave the
 * entry on Icon=rozelynx - the hicolor name whose scalable slot is the
 * discontinued old logo - and a site whose icon only existed as a URL the
 * content script could not read (a CDN without CORS response headers)
 * stored icon:null with no record of the URL, so nothing could retry it.
 * The ladder answers all of that: the packaged fallback art materialises
 * through the same parent write as a site icon, so the entry gets an
 * absolute path a launcher renders directly. */
async function sectionH() {
  // The packaged artwork itself, served the way the background page reads
  // it (fetch + arrayBuffer): the real bytes from the real file, so the
  // check on the far side of the parent write is about the real asset.
  const realPng = fs.readFileSync(path.join(EXT, 'icons/pwa-fallback.png'));
  ok(realPng.length > 8 && realPng[0] === 0x89 && realPng[1] === 0x50,
    'H.0 the packaged fallback asset exists and is a PNG',
    realPng.length + ' bytes');
  const serveFallback = () => Promise.resolve({
    ok: true,
    arrayBuffer: async () => realPng.buffer.slice(
      realPng.byteOffset, realPng.byteOffset + realPng.length),
  });

  {
    // A site with no icon: the entry must fall to the packaged art, not the
    // theme name, and the site record must NOT be overwritten with it - the
    // fallback is the browser's brand, not the site's favicon.
    const s = site('NoIcon');
    s.icon = null;
    const h = await booted([s], { fetch: serveFallback });
    try {
      const body = h.entryFor(s);
      const icon = body.split('\n').find(l => l.startsWith('Icon='))
        .slice('Icon='.length);
      ok(icon.endsWith(path.join('pwa-icons', 'rozelynx-pwa-fallback.png')),
        'H.1 Icon= names the materialised fallback file', icon);
      ok(path.isAbsolute(icon), 'H.2 ...as an absolute path', icon);
      ok(fs.existsSync(icon), 'H.3 ...which exists on disk');
      ok(fs.readFileSync(icon).equals(realPng),
        'H.4 ...carrying the packaged artwork bytes');
      ok(body.includes('--ssb-icon ' + icon),
        'H.5 ...and --ssb-icon agrees with it');
      ok(/source=fallback/.test(h.diagText()),
        'H.6 the ring says which rung answered', h.diagText());
      const sites = JSON.parse(h.storage.rozelynx_pwa_sites);
      eq(sites[0].icon, null,
        "H.7 the fallback is NOT stored as the site's own favicon");
    } finally { h.cleanup(); }
  }

  {
    // A site whose icon is only a candidate URL: the content script could
    // not read it (CORS), the background can (host permissions). The entry
    // must land on the candidate's bytes, re-encoded through the canvas to
    // a PNG, and the record must be upgraded so the next pass is the fast
    // first rung. `dom: true` models the background page's own Image and
    // canvas, so the re-encode rung itself runs - against a canvas that
    // answers the real 1x1 PNG, which is what the byte assertions read.
    const png = Buffer.from('89504e47', 'hex');   // a PNG signature, loadable bytes
    const s = site('CdnApp');
    s.icon = null;
    s.iconCandidates = ['https://cdn.example/icon-192.png'];
    const h = await booted([s], {
      dom: true,
      fetch: (u) => {
        if (String(u) === 'https://cdn.example/icon-192.png') {
          return Promise.resolve({
            ok: true,
            arrayBuffer: async () => png.buffer.slice(
              png.byteOffset, png.byteOffset + png.length),
          });
        }
        return serveFallback();
      },
    });
    try {
      const body = h.entryFor(s);
      const icon = body.split('\n').find(l => l.startsWith('Icon='))
        .slice('Icon='.length);
      ok(icon.endsWith(s.id + '.png'),
        'H.8 a candidate the background CAN fetch lands as the site icon',
        icon);
      eq(fs.readFileSync(icon).toString('base64'),
        DATA_PNG.split(',')[1],
        'H.9 ...re-encoded through the canvas to the PNG it answers');
      ok(/source=favicon/.test(h.diagText()),
        'H.10 ...and the rung is named in the ring', h.diagText());
      const sites = JSON.parse(h.storage.rozelynx_pwa_sites);
      eq(sites[0].icon, DATA_PNG,
        "H.11 the win is persisted into the site record (as the PNG data URL)");
    } finally { h.cleanup(); }
  }

  {
    // A live tab favicon (favIconUrl) is harvested when the record has
    // neither an icon nor candidates - the third rung. The boot runs on
    // the default no-net stub so the startup entry lands on Icon=rozelynx
    // (nothing servable); the favicon arrives only with the tab, which is
    // exactly how a real profile gets here: installed with no icon, then
    // revisited.
    const png = Buffer.from('89504e47', 'hex');   // a PNG signature
    const s = site('LiveTab');
    s.icon = null;
    const h = await booted([s]);
    try {
      let faviconAsked = null;
      h.ctx.fetch = (u) => {
        faviconAsked = String(u);
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => png.buffer.slice(
            png.byteOffset, png.byteOffset + png.length),
        });
      };
      h.ctx.browser.tabs.query = () => Promise.resolve([{
        id: 1,
        favIconUrl: 'https://live-tab.example/favicon.ico',
      }]);
      const r = await h.send({ module: 'pwa', action: 'reconcile-entries' });
      eq(r.upgraded, 1, 'H.12 the stale entry is upgraded by the pass',
        JSON.stringify(r));
      eq(r.failed, 0, 'H.13 ...cleanly');
      const body = h.entryFor(s);
      const icon = body.split('\n').find(l => l.startsWith('Icon='))
        .slice('Icon='.length);
      ok(icon.endsWith(s.id + '.png'),
        'H.14 a tab favicon reaches the entry when nothing else could', icon);
      ok(fs.readFileSync(icon).equals(png), 'H.15 ...with its bytes');
      eq(faviconAsked, 'https://live-tab.example/favicon.ico',
        'H.16 ...fetched under this page\'s permissions, not the page\'s');
    } finally { h.cleanup(); }
  }

  {
    // No fallback servable (an old parent, a read-only profile - modelled
    // here by a fetch that cannot answer): the entry degrades to the theme
    // name exactly as before, and says which rung failed.
    const s = site('NoNet');
    s.icon = null;
    const h = await booted([s]);
    try {
      const body = h.entryFor(s);
      const icon = body.split('\n').find(l => l.startsWith('Icon='))
        .slice('Icon='.length);
      eq(icon, 'rozelynx',
        'H.15 with nothing servable, the entry degrades to the theme name');
      ok(!body.includes('--ssb-icon '),
        'H.16 ...and no --ssb-icon is emitted for it');
      ok(/source=none/.test(h.diagText()),
        'H.17 ...and the ring names the rung', h.diagText());
    } finally { h.cleanup(); }
  }
}

/* ---------------------------------------------------------------- I */

/* The second half of idempotence (v1.0.73): an entry that EXISTS is left
 * alone only while its Icon= is one the pipeline still stands behind. The
 * pre-1.0.73 writer emitted Icon=rozelynx for any site without a usable
 * icon - so every entry installed before this version is one upgrade away,
 * and the upgrade has to happen by itself, because the only other way to
 * get it is to uninstall and reinstall each app by hand. */
async function sectionI() {
  const s = site('Alpha');
  const h = await booted([s]);
  try {
    const name = h.files().find(f => f.includes(s.id));
    const p = path.join(h.appDir, name);
    const live = h.entryFor(s).split('\n')
      .find(l => l.startsWith('Icon=')).slice('Icon='.length);
    ok(live && fs.existsSync(live), 'I.0 the fresh entry carries a live icon', live);

    // (1) the pre-1.0.73 entry: the theme-name fallback.
    fs.writeFileSync(p,
      fs.readFileSync(p, 'utf8').replace(/^Icon=.*$/m, 'Icon=rozelynx'));
    let r = await h.send({ module: 'pwa', action: 'reconcile-entries' });
    eq(r.upgraded, 1, 'I.1 a theme-name Icon= is upgraded');
    eq(r.written, 0, 'I.2 ...counted as an upgrade, not a fresh write');
    eq(r.present, 0, 'I.3 ...and not as present');
    eq(r.failed, 0, 'I.4 ...cleanly');
    let icon = h.entryFor(s).split('\n')
      .find(l => l.startsWith('Icon=')).slice('Icon='.length);
    ok(icon.startsWith(path.join(h.sb.profd, 'pwa-icons')),
      'I.5 the rewritten entry carries a real path', icon);
    ok(fs.existsSync(icon), 'I.6 ...that exists');
    // and the rewrite is not a footgun: the second pass sees it as present.
    r = await h.send({ module: 'pwa', action: 'reconcile-entries' });
    eq(r.present, 1, 'I.7 an upgraded entry is present on the next pass');
    eq(r.upgraded, 0, 'I.8 ...and upgrades nothing again');

    // (2) an absolute path whose file has gone away: the cleaned-profile
    // case. The materialised file comes back as part of the rewrite, so
    // the new entry is live again, not circular.
    fs.unlinkSync(icon);
    r = await h.send({ module: 'pwa', action: 'reconcile-entries' });
    eq(r.upgraded, 1, 'I.9 an entry whose icon file was deleted is rewritten');
    icon = h.entryFor(s).split('\n')
      .find(l => l.startsWith('Icon=')).slice('Icon='.length);
    ok(fs.existsSync(icon), 'I.10 ...and points at a file that exists again');

    // (3) a blank Icon= - the "blank icon" half of the live complaint - is
    // upgraded too, not tolerated because the file is technically there.
    fs.writeFileSync(p,
      fs.readFileSync(p, 'utf8').replace(/^Icon=.*$/m, 'Icon='));
    r = await h.send({ module: 'pwa', action: 'reconcile-entries' });
    eq(r.upgraded, 1, 'I.11 an empty Icon= is upgraded');
    icon = h.entryFor(s).split('\n')
      .find(l => l.startsWith('Icon=')).slice('Icon='.length);
    ok(icon && fs.existsSync(icon), 'I.12 ...to a real file');

    // (4) a parent that reports NO icon field (an older build) cannot be
    // known: present, untouched - not rewritten on a guess, which would be
    // every entry on every start-up forever.
    const realHas = h.winApi.hasDesktopEntry;
    const before = fs.statSync(p).mtimeMs;
    h.winApi.hasDesktopEntry = (fn) =>
      realHas(fn).then(({ icon, iconExists, ...rest }) => rest);
    r = await h.send({ module: 'pwa', action: 'reconcile-entries' });
    eq(r.present, 1, 'I.13 an old parent reports present');
    eq(r.upgraded, 0, 'I.14 ...and triggers no rewrite');
    eq(fs.statSync(p).mtimeMs, before, 'I.15 ...the file is untouched');
    h.winApi.hasDesktopEntry = realHas;
  } finally { h.cleanup(); }
}

/* ---------------------------------------------------------------- J */

/* PWAManager.install has no caller in the extension (the live path is the
 * content script's installPWA), but it is kept correct anyway - so its icon
 * half keeps the same ladder. Driven with a fetch stub because the module
 * fetches the manifest itself, this section proves the ranked ladder, the
 * candidates kept on failure, and the entry still landing on a real icon
 * file when the record itself could not hold one. */
async function sectionJ() {
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJ' +
    'AAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const manifest = {
    name: 'JApp',
    short_name: 'JApp',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    icons: [
      { src: '/icons/blocked.webp', sizes: '512x512', type: 'image/webp',
        purpose: 'any' },
      { src: 'https://cdn.example/icon-192.png', sizes: '192x192',
        type: 'image/png', purpose: 'any' },
    ],
  };
  const h = await booted([], {
    // dom: the ranked PNG candidate is re-encoded through the background
    // page's canvas before it is stored - the same rung as H.9 - and this
    // sandbox has no canvas of its own to agree with.
    dom: true,
    fetch: (u) => {
      if (String(u).endsWith('/manifest.json')) {
        return Promise.resolve({ ok: true, json: async () => manifest });
      }
      if (String(u) === 'https://cdn.example/icon-192.png') {
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => png.buffer.slice(
            png.byteOffset, png.byteOffset + png.length),
        });
      }
      // A CORS-refusing CDN: the URL is kept as a candidate.
      return Promise.resolve({ ok: false, status: 404 });
    },
  });
  try {
    const data = { url: 'https://app9.example/',
      manifestUrl: 'https://app9.example/manifest.json' };
    const r = await h.send({ module: 'pwa', action: 'install', data });
    ok(r.success, 'J.1 the install succeeds', JSON.stringify(r && r.error));
    const site = r.site;
    eq(site.name, 'JApp', 'J.2 the site record carries the manifest name');
    ok(/^data:image\/png[;,]/.test(String(site.icon || '')),
      'J.3 the ranked PNG won and was stored as a PNG data URL',
      String(site.icon).slice(0, 40));
    eq(site.iconCandidates, [],
      'J.4 a winner means no candidates are kept');
    const sites = JSON.parse(h.storage.rozelynx_pwa_sites);
    eq(sites.length, 1, 'J.5 the record is persisted');
    const icon = h.entryFor(site).split('\n')
      .find(l => l.startsWith('Icon=')).slice('Icon='.length);
    ok(icon.endsWith(site.id + '.png'), 'J.6 the entry names the materialised icon', icon);
    ok(fs.existsSync(icon) && fs.readFileSync(icon).equals(png),
      'J.7 ...which is the candidate PNG on disk');
  } finally { h.cleanup(); }

  // And the blocked-icon half: a manifest whose ONLY icon is a URL this
  // stub refuses. The record keeps the URL as a candidate; the entry still
  // gets a real file through the fallback art - which is exactly what the
  // packaged artwork exists for.
  {
    const realPng = fs.readFileSync(path.join(EXT, 'icons/pwa-fallback.png'));
    const onlyBlocked = { name: 'KApp', start_url: '/', scope: '/',
      display: 'standalone',
      icons: [{ src: '/icons/blocked.png', sizes: '192x192',
        type: 'image/png', purpose: 'any' }] };
    const h2 = await booted([], {
      dom: true,
      fetch: (u) => {
        if (String(u).endsWith('/manifest2.json')) {
          return Promise.resolve({ ok: true, json: async () => onlyBlocked });
        }
        if (String(u).endsWith('blocked.png')) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        return Promise.resolve({
          ok: true,
          arrayBuffer: async () => realPng.buffer.slice(
            realPng.byteOffset, realPng.byteOffset + realPng.length),
        });
      },
    });
    try {
      const r2 = await h2.send({ module: 'pwa', action: 'install', data: {
        url: 'https://kapp.example/',
        manifestUrl: 'https://kapp.example/manifest2.json' } });
      ok(r2.success, 'J.8 the blocked-icon install still succeeds',
        JSON.stringify(r2 && r2.error));
      ok(r2.site.iconCandidates.length === 1 &&
         r2.site.iconCandidates[0].endsWith('/icons/blocked.png'),
        'J.9 the refused URL is kept as a candidate',
        JSON.stringify(r2.site.iconCandidates));
      const icon2 = h2.entryFor(r2.site).split('\n')
        .find(l => l.startsWith('Icon=')).slice('Icon='.length);
      ok(icon2.endsWith(path.join('pwa-icons', 'rozelynx-pwa-fallback.png')),
        'J.10 the entry lands on the packaged fallback art', icon2);
      ok(fs.existsSync(icon2) && fs.readFileSync(icon2).equals(realPng),
        'J.11 ...carrying the artwork bytes');
    } finally { h2.cleanup(); }
  }
}

const SECTIONS = [
  ['A', 'the start-up pass writes what is missing', sectionA],
  ['B', 'reconcile is idempotent', sectionB],
  ['C', 'the pref gate, and ungated removal', sectionC],
  ['D', 'one failure does not stop the rest', sectionD],
  ['E', 'the entry content', sectionE],
  ['F', 'the entry and the launch path agree', sectionF],
  ['G', 'message hygiene', sectionG],
  ['H', 'the icon ladder: fallback, candidates, favicons', sectionH],
  ['I', 'reconcile upgrades stale Icon= entries', sectionI],
  ['J', 'PWAManager.install keeps the same ladder', sectionJ],
];

async function step(n, name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(false, 'section ' + n + ' (' + name + ') crashed',
      (e && e.message || String(e)).split('\n')[0]);
  }
}

run('pwa-launcher-entries', async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-pwa-entries-'));
  try {
    for (const [n, name, fn] of SECTIONS) await step(n, name, fn);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
