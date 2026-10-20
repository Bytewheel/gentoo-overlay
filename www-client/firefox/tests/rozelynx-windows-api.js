#!/usr/bin/env node
'use strict';
/* Harness for the `rozelynxWindows` experiment API.
 *
 * Why this exists: the API's directory creation used to say
 * `dir.create(Ci.nsIFile.DIRECTORY, 0o755)`. nsIFile declares no DIRECTORY
 * constant, so that was `undefined`, XPConnect coerced it to 0, 0 is
 * NORMAL_FILE_TYPE, and the call created an empty 0755 plain FILE named after
 * the directory. Every write under it then failed - and it shipped, because
 * every fake nsIFile before this one treated any create() as "a directory".
 *
 * So the fake in lib/xpcomfile.js models Gecko instead of agreeing with the
 * code, and the checks below are chosen to catch that specific class of
 * mistake: what lands on disk, not just what the API returns.
 *
 * Sections:
 *   1  directory creation is really a directory, and the mode is what was asked
 *   2  the bare Ci.nsIFile.DIRECTORY form cannot survive this sandbox
 *   3  the artifact the bug left behind is repaired, and only that artifact
 *   4  writeIconFile's contract (bytes, mode, path, refusals)
 *   5  writeDesktopEntry / removeDesktopEntry
 *   6  getProfilePath
 *   7  the rest of the namespace still answers (spot check)
 *   8  window resolution: the route Gecko itself uses, and no sandbox QI
 *   9  hasDesktopEntry, the read half reconcile needs
 *  10  the schema and the implementation agree
 *  11  the --ssb handler probe reports
 *  12  writeIconFile sniffs the payload, whatever the server called it
 *  13  hasDesktopEntry reads the Icon= key back (v1.0.73)
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const { ok, eq, run } = require('./lib/check.js');
const { root, requireTree } = require('./lib/roots.js');
const { makeSandbox, loadApi, coerceCreateType, FakeChromeWindow, FakeTaskbar,
        DIRECTORY_TYPE, NORMAL_FILE_TYPE } = require('./lib/xpcomfile.js');

const ROOT = requireTree(root(process.argv), 'extension tree');
const EXT = ROOT;

const PNG_1x1 =
  'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
function decodedLen(dataUrl) {
  return Buffer.from(dataUrl.split(',')[1], 'base64').length;
}

const SVG_1x1 =
  'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciLz4=';

let scratch;

function fresh(extra) {
  const dir = fs.mkdtempSync(path.join(scratch, 'rz-win-'));
  const sb = makeSandbox(Object.assign({ tmpDir: dir }, extra || {}));
  const api = loadApi(EXT, sb);
  return { dir, sb, api };
}

/* 1 --------------------------------------------------------------- */

async function section1() {
  // The regression, stated as an observation rather than as a return value:
  // pwa-icons must be a DIRECTORY on disk.
  {
    const { sb, api } = fresh();
    const res = await api.writeIconFile(PNG_1x1, 'pwa-abc123');
    ok(res.ok, '1.1 writeIconFile succeeded', JSON.stringify(res));
    const icons = sb.fsys.abs(path.join(sb.profd, 'pwa-icons'));
    ok(sb.fsys.isDir(icons), '1.2 <profile>/pwa-icons is a DIRECTORY',
      'it is ' + (sb.fsys.isFile(icons) ? 'a plain file' : 'missing'));
    const child = path.join(icons, 'pwa-abc123.png');
    ok(sb.fsys.isFile(child), '1.3 the icon file itself exists');
    const st = fs.statSync(child);
    const want = Buffer.from(PNG_1x1.split(',')[1], 'base64');
    ok(st.size === want.length, '1.4 the bytes on disk equal the decoded data URL',
      st.size + ' vs ' + want.length);
    ok(fs.readFileSync(child).equals(want), '1.5 the bytes compare equal byte-for-byte');
    ok((st.mode & 0o777) === 0o644, '1.6 mode is 0644',
      '0' + (st.mode & 0o777).toString(8));
    eq(res.path, child, '1.7 the returned path is the real path');
  }

  // A second write into the same profile must not re-create or disturb the
  // directory: `if (!exists)` used to be the whole guard.
  {
    const { sb, api } = fresh();
    await api.writeIconFile(PNG_1x1, 'pwa-one');
    await api.writeIconFile(SVG_1x1, 'pwa-two');
    const icons = sb.fsys.abs(path.join(sb.profd, 'pwa-icons'));
    ok(sb.fsys.isDir(icons), '1.8 the directory survives a second write');
    eq(sb.fsys.list(icons),
      ['pwa-one.png (' + decodedLen(PNG_1x1) + 'b)',
       'pwa-two.svg (' + decodedLen(SVG_1x1) + 'b)'],
      '1.9 both files are there');
  }
}

/* 2 --------------------------------------------------------------- */

async function section2() {
  // The sandbox must not be able to model the old call as anything but wrong.
  // If someone "fixes" lib/xpcomfile.js by adding a DIRECTORY alias, these fail
  // and say why, which is the whole point of asserting the fake too.
  {
    const { sb } = fresh();
    eq(sb.Ci.nsIFile.DIRECTORY, undefined, '2.1 Ci.nsIFile.DIRECTORY is undefined, as in Gecko');
    eq(sb.Ci.nsIFile.DIRECTORY_TYPE, DIRECTORY_TYPE, '2.2 DIRECTORY_TYPE is 1');
    eq(sb.Ci.nsIFile.NORMAL_FILE_TYPE, NORMAL_FILE_TYPE, '2.3 NORMAL_FILE_TYPE is 0');
    // The coercion XPConnect performs for `in unsigned long type`: a missing or
    // undefined argument arrives as 0. Number(undefined) would be NaN, which is
    // why this asks the fake's own coercion rather than doing the arithmetic
    // here.
    eq(coerceCreateType(sb.Ci.nsIFile.DIRECTORY), NORMAL_FILE_TYPE,
      '2.4 which is exactly what create() receives');
  }

  // Prove the coercion end-to-end against the real fake: creating a directory
  // with the old expression must produce the artifact the bug produced.
  {
    const { sb } = fresh();
    const { FakeNode } = require('./lib/xpcomfile.js');
    const bad = new FakeNode(path.join(sb.profd, 'pwa-icons'), false);
    bad._fs = sb.fsys;
    bad.create(sb.Ci.nsIFile.DIRECTORY, 0o755); // the old line, verbatim
    ok(sb.fsys.isFile(sb.fsys.abs(path.join(sb.profd, 'pwa-icons'))),
      '2.5 the old expression really does create a plain file');
    const st = fs.statSync(sb.fsys.abs(path.join(sb.profd, 'pwa-icons')));
    eq(st.size, 0, '2.6 ...of size 0');
    eq(st.mode & 0o777, 0o755, '2.7 ...with the requested mode 0755');
  }

  // The guard has to be load-bearing. A sandbox whose Gecko has renamed the
  // constant must produce a NAMED failure, not another silent plain file -
  // that is the whole reason the constant is resolved through a name check
  // instead of being used directly, and it is the check that stops this bug
  // from coming back one version bump later.
  {
    const dir = fs.mkdtempSync(path.join(scratch, 'rz-win-nodt-'));
    const sb = makeSandbox({ tmpDir: dir });
    delete sb.Ci.nsIFile.DIRECTORY_TYPE;
    const api = loadApi(EXT, sb);
    const res = await api.writeIconFile(PNG_1x1, 'pwa-abc123');
    eq(res.ok, false, '2.11 a Gecko with no DIRECTORY_TYPE is a named failure');
    ok(/DIRECTORY_TYPE is unavailable/.test(res.error || ''),
      '2.12 ...naming the missing constant', res.error);
    ok(!sb.fsys.has(path.join(sb.profd, 'pwa-icons')),
      '2.13 ...and nothing was created on the way to failing');
    const entry = '[Desktop Entry]\nType=Application\n';
    const dres = await api.writeDesktopEntry('a.desktop', entry);
    eq(dres.ok, false, '2.14 writeDesktopEntry refuses it too');
    ok(/DIRECTORY_TYPE is unavailable/.test(dres.error || ''),
      '2.15 ...with the same reason', dres.error);
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // The source must not still be calling the form that cannot work.
  {
    const src = fs.readFileSync(path.join(EXT, 'lib/experiments/windows-api.js'), 'utf8');
    const calls = src.match(/\.create\(\s*Ci\.nsIFile\.[A-Z_]+\s*,/g) || [];
    eq(calls, [], '2.8 no create(Ci.nsIFile.*) call left in the file');
    const bare = src.match(/Ci\.nsIFile\.DIRECTORY(?!_)/g) || [];
    // One occurrence is allowed and required: the comment that names the bug.
    ok(bare.length <= 1, '2.9 the bare DIRECTORY form appears only in the bug comment',
      bare.length + ' occurrences');
    ok(src.includes('Ci.nsIFile.DIRECTORY_TYPE'),
      '2.10 DIRECTORY_TYPE is what the code uses');
  }
}

/* 3 --------------------------------------------------------------- */

async function section3() {
  // The artifact this bug leaves is a 0-byte plain file at the directory's
  // path. It must heal, because a profile that hit it is otherwise broken for
  // good and the user is left with an unexplained feature that stopped working.
  {
    const { sb, api } = fresh();
    const icons = path.join(sb.profd, 'pwa-icons');
    fs.mkdirSync(sb.profd, { recursive: true });
    fs.writeFileSync(icons, '');            // exactly what create(0, 0755) leaves
    fs.chmodSync(icons, 0o755);

    const res = await api.writeIconFile(PNG_1x1, 'pwa-abc123');
    ok(res.ok, '3.1 the write succeeds over the artifact', JSON.stringify(res));
    ok(sb.fsys.isDir(icons), '3.2 the artifact was replaced by a directory');
    eq(res.repaired, true, '3.3 the repair is reported, not silent');
    ok(sb.fsys.isFile(path.join(icons, 'pwa-abc123.png')), '3.4 the icon is written');
  }

  // A path the code cannot prove it created is refused by name, not deleted.
  {
    const { sb, api } = fresh();
    const icons = path.join(sb.profd, 'pwa-icons');
    fs.mkdirSync(sb.profd, { recursive: true });
    fs.writeFileSync(icons, 'not ours');
    const res = await api.writeIconFile(PNG_1x1, 'pwa-abc123');
    ok(res.ok === false, '3.5 a non-empty file at the path is refused');
    ok(/-byte file, not an empty one/.test(res.error || ''),
      '3.6 ...with an error that names the problem', res.error);
    eq(fs.readFileSync(icons, 'utf8'), 'not ours', '3.7 ...and its content is untouched');
  }

  // The same guarantee for the applications directory.
  {
    const { sb, api } = fresh({ env: { XDG_DATA_HOME: '' } });
    const apps = path.join(sb.home, '.local/share/applications');
    fs.mkdirSync(path.dirname(apps), { recursive: true });
    fs.writeFileSync(apps, '');
    const res = await api.writeDesktopEntry('rozelynx-pwa-x-pwa-1.desktop',
      '[Desktop Entry]\nType=Application\nName=X\n');
    ok(res.ok, '3.8 the applications artifact is repaired too', JSON.stringify(res));
    ok(fs.statSync(apps).isDirectory(), '3.9 ...leaving a real directory');
    ok(fs.readFileSync(path.join(apps, 'rozelynx-pwa-x-pwa-1.desktop'), 'utf8')
      .startsWith('[Desktop Entry]'), '3.10 ...with the entry written inside it');
  }
}

/* 4 --------------------------------------------------------------- */

async function section4() {
  const { sb, api } = fresh();

  const r = await api.writeIconFile('data:image/png;base64,' + Buffer.from('hello').toString('base64'), 'pwa-1');
  eq(r.bytes, 5, '4.1 byte count is reported');
  ok(fs.readFileSync(r.path, 'utf8') === 'hello', '4.2 content round-trips');

  // The name is sanitised, never escaped: nothing can climb out of pwa-icons/.
  const t = await api.writeIconFile(PNG_1x1, '../../../etc/passwd');
  ok(t.ok, '4.3 a traversal name is accepted but contained', JSON.stringify(t));
  ok(t.path.startsWith(path.join(sb.profd, 'pwa-icons') + path.sep),
    '4.4 ...inside pwa-icons/', t.path);

  const dots = await api.writeIconFile(PNG_1x1, '...');
  ok(path.basename(dots.path).startsWith('icon'), '4.5 a name that sanitises to nothing falls back',
    dots.path);

  const long = await api.writeIconFile(PNG_1x1, 'x'.repeat(300));
  ok(path.basename(long.path).length <= 64 + 4, '4.6 an over-long name is bounded',
    path.basename(long.path).length);

  eq((await api.writeIconFile('https://example.com/i.png', 'pwa-2')).ok, false,
    '4.7 a plain URL is refused, not written');
  eq((await api.writeIconFile('data:text/html;base64,PGh0bWw+', 'pwa-3')).ok, false,
    '4.8 text/html is refused');
  eq((await api.writeIconFile('data:image/png,notbase64', 'pwa-4')).ok, false,
    '4.9 a percent-encoded (non-base64) payload is refused');
  eq((await api.writeIconFile('data:image/png;base64,@@@@', 'pwa-5')).ok, false,
    '4.10 a corrupt payload is refused');
  eq((await api.writeIconFile('', 'pwa-6')).ok, false, '4.11 an empty data URL is refused');
  eq((await api.writeIconFile('data:image/png;base64,', 'pwa-7')).ok, false,
    '4.12 an empty payload is refused');

  // mime -> extension, for each accepted type
  const types = [['image/png', '.png'], ['image/jpeg', '.jpg'], ['image/gif', '.gif'],
    ['image/webp', '.webp'], ['image/bmp', '.bmp'], ['image/x-icon', '.ico'],
    ['image/svg+xml', '.svg']];
  for (const [mime, ext] of types) {
    const res = await api.writeIconFile(
      'data:' + mime + ';base64,' + Buffer.from('x').toString('base64'), 'pwa-m');
    ok(res.ok && res.path.endsWith(ext), '4.13 ' + mime + ' -> ' + ext,
      JSON.stringify(res));
  }

  // A missing ProfD is a named failure, not an exception.
  {
    const broken = fresh();
    broken.sb.Services.dirsvc.get = () => { throw new Error('no ProfD'); };
    const res = await broken.api.writeIconFile(PNG_1x1, 'pwa-8');
    eq(res.ok, false, '4.14 a ProfD failure is named');
    ok(/ProfD/.test(res.error), '4.15 ...and says which lookup failed', res.error);
  }
}

/* 5 --------------------------------------------------------------- */

async function section5() {
  const entry = '[Desktop Entry]\nType=Application\nName=Demo\nExec=rozelynx --ssb https://x/\n';
  const { sb, api } = fresh();
  const apps = path.join(sb.home, '.local/share/applications');

  const w = await api.writeDesktopEntry('rozelynx-pwa-demo-pwa-1.desktop', entry);
  ok(w.ok, '5.1 the entry is written', JSON.stringify(w));
  ok(fs.readFileSync(path.join(apps, w.name), 'utf8') === entry, '5.2 ...byte-for-byte');
  eq(fs.statSync(path.join(apps, w.name)).mode & 0o777, 0o644, '5.3 mode is 0644');
  eq(w.name, 'rozelynx-pwa-demo-pwa-1.desktop', '5.4 the name is what was asked for');

  // The directory is created when it is missing - including the intermediate
  // ~/.local/share, which the same create() call is responsible for.
  {
    const bare = fresh();
    const res = await bare.api.writeDesktopEntry('a.desktop', entry);
    ok(res.ok, '5.5 a missing ~/.local/share/applications is created', JSON.stringify(res));
    ok(bare.sb.fsys.isDir(apps), '5.6 ...as a real directory');
  }

  // XDG_DATA_HOME, per the spec: absolute is honoured, relative is not.
  {
    const x = fresh({ env: { XDG_DATA_HOME: '/tmp/rz-xdg-probe' } });
    fs.rmSync('/tmp/rz-xdg-probe', { recursive: true, force: true });
    const res = await x.api.writeDesktopEntry('a.desktop', entry);
    ok(res.ok, '5.7 an absolute XDG_DATA_HOME is used', JSON.stringify(res));
    ok(fs.existsSync('/tmp/rz-xdg-probe/applications/a.desktop'), '5.8 ...under applications/');
    fs.rmSync('/tmp/rz-xdg-probe', { recursive: true, force: true });
  }
  {
    const x = fresh({ env: { XDG_DATA_HOME: 'relative/path' } });
    const res = await x.api.writeDesktopEntry('a.desktop', entry);
    ok(res.ok && res.path.startsWith(x.sb.home), '5.9 a relative XDG_DATA_HOME is ignored', res.path);
  }

  // Refusals.
  eq((await api.writeDesktopEntry('a.desktop', 'not an entry')).ok, false,
    '5.10 content that is not a [Desktop Entry] is refused');
  eq((await api.writeDesktopEntry('a.desktop', '')).ok, false, '5.11 empty content is refused');
  eq((await api.writeDesktopEntry('...', entry)).ok, false, '5.12 a name that sanitises to nothing is refused');
  {
    const trav = await api.writeDesktopEntry('../../../etc/evil.desktop', entry);
    ok(trav.ok, '5.13 a traversal name is contained');
    ok(trav.path.startsWith(apps), '5.14 ...inside applications/', trav.path);
  }
  {
    const long = await api.writeDesktopEntry('z'.repeat(200) + '.desktop', entry);
    // desktopFileName() slices the stem to 64 and then forces the suffix, so
    // 64 + 8 is the bound, and the suffix is still there.
    ok(path.basename(long.name).length <= 64 + '.desktop'.length,
      '5.15 an over-long name is bounded to 64 + the suffix',
      path.basename(long.name).length);
    ok(long.name.endsWith('.desktop'), '5.15b ...and keeps the forced suffix');
  }
  {
    const wrongExt = await api.writeDesktopEntry('sneaky.desktop.desktop.desktop', entry);
    ok(wrongExt.name.endsWith('.desktop'), '5.16 the .desktop suffix is forced', wrongExt.name);
  }
  {
    const res = await api.writeDesktopEntry('a.desktop', entry);
    const first = fs.readFileSync(res.path, 'utf8');
    await api.writeDesktopEntry('a.desktop', '[Desktop Entry]\n');
    const second = fs.readFileSync(res.path, 'utf8');
    ok(first.length > second.length && second === '[Desktop Entry]\n',
      '5.17 a shorter entry truncates the longer one (PR_TRUNCATE)', second.length);
  }

  // Removal.
  const gone = await api.removeDesktopEntry('a.desktop');
  ok(gone.ok && gone.removed, '5.18 remove reports removed=true');
  ok(!fs.existsSync(gone.path), '5.19 the file is gone');
  const again = await api.removeDesktopEntry('a.desktop');
  ok(again.ok && again.removed === false, '5.20 removing an absent entry is ok, removed=false');
}

/* 6 --------------------------------------------------------------- */

async function section6() {
  const { sb, api } = fresh();
  const r = await api.getProfilePath();
  ok(r.ok, '6.1 getProfilePath answers');
  eq(r.path, sb.profd, '6.2 it is ProfD');

  const broken = fresh();
  broken.sb.Services.dirsvc.get = () => { throw new Error('boom'); };
  const f = await broken.api.getProfilePath();
  eq(f.ok, false, '6.3 a ProfD failure is {ok:false}');
  ok(/ProfD/.test(f.error), '6.4 ...naming the lookup', f.error);

  const empty = fresh();
  empty.sb.Services.dirsvc.get = () => ({ get path() { return ''; }, clone() { return this; } });
  eq((await empty.api.getProfilePath()).ok, false, '6.5 an empty path is refused');
}

/* 7 --------------------------------------------------------------- */

async function section7() {
  // Spot check the rest of the namespace: the fix must not have broken the
  // functions that were already there, which is the invariant every part of
  // this plan keeps re-asserting for a shared file.
  const { api } = fresh();
  eq((await api.setSsbMode(7, true)).ok, false, '7.1 an unknown window is {ok:false}');
  ok(/window not found/.test((await api.setSsbMode(7, true)).error),
    '7.2 ...naming the reason');
  eq((await api.setWindowClass(0, '')).ok, false, '7.3 an empty class is refused');
  eq((await api.setWindowIconFromPath(0, '')).ok, false, '7.4 an empty icon path is refused');
  eq((await api.setPrefersColorScheme(0, 'nonsense')).ok, false, '7.5 an invalid scheme is refused');
  const t = await api.isTaskbarAvailable();
  eq(t.ok, true, '7.6 isTaskbarAvailable answers {ok:true} with available=false when absent');
  eq(t.available, false, '7.7 ...because this sandbox has no taskbar component');
}

/* A section that throws is a failure, not a crash.
 *
 * This is not hypothetical: run against the pre-fix source the first section
 * throws ENOTDIR at check 1.4 - the very bug it exists to catch - and a
 * harness that stops there reports "1 passed, 2 failed" instead of the 80-odd
 * checks that also describe what the fix must preserve. lib/check.js already
 * states the rule for `ok()`; this is the same rule one level up, for code
 * this harness itself wrote. */
async function step(n, name, fn) {
  try {
    await fn();
  } catch (e) {
    ok(false, n + ' ' + name + ' crashed',
      (e && e.message || String(e)).split('\n')[0]);
  }
}

const SECTIONS = [
  ['1', 'directory creation', section1],
  ['2', 'the bare constant cannot work', section2],
  ['3', 'the artifact is repaired, and only that artifact', section3],
  ['4', 'writeIconFile', section4],
  ['5', 'writeDesktopEntry / removeDesktopEntry', section5],
  ['6', 'getProfilePath', section6],
  ['7', 'the rest of the namespace still answers', section7],
  ['8', 'window resolution', section8],
  ['9', 'hasDesktopEntry', section9],
  ['10', 'schema and implementation agree', section10],
  ['11', 'the --ssb handler probe reports', section11],
  ['12', 'writeIconFile sniffs the payload', section12],
  ['13', 'hasDesktopEntry reads the Icon= back', section13],
];

/* 8 --------------------------------------------------------------- */

/* Drive the real setWindowClass/setWindowIconFromPath against a taskbar stub,
 * so "the component was actually called, with this window" is observable.
 *
 * `opts.sandbox.console` is attached after makeSandbox because that function
 * returns a fixed shape and would drop it. loadApi otherwise installs Node's
 * real console, which would print the warning this harness asserts on - a
 * stand-in that swallows the warning cannot report that something is missing,
 * which is the same trap the mouse-gestures harness fell into. */
async function withTaskbar(opts, extra, fn) {
  const dir = fs.mkdtempSync(path.join(scratch, 'rz-win-taskbar-'));
  const taskbar = new FakeTaskbar(opts.taskbar);
  const sb = makeSandbox(Object.assign({ tmpDir: dir }, opts.sandbox || {}));
  if (opts.sandbox && opts.sandbox.console) sb.console = opts.sandbox.console;
  sb.Cc['@bytewheel.org/pwa/linux-taskbar;1'] = {
    getService() {
      if (opts.noComponent) throw new Error('NS_ERROR_FAILURE: no such component');
      return taskbar;
    },
  };
  const api = loadApi(EXT, sb);
  try {
    await fn(api, taskbar, sb);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

async function section8() {
  // The route Gecko itself uses: Services.wm.getOuterWindowWithId, which is
  // literally WindowTrackerBase.getWindow (ext-tabs-base.js:1855). It has to
  // work with the id as a number AND as a string, because the value the
  // extension API hands over is a number while docShell.outerWindowID is not
  // guaranteed to arrive as one.
  for (const idAsString of [false, true]) {
    const label = idAsString ? ' (outerWindowID as a string)' : '';
    await withTaskbar({ sandbox: { windows: [{ id: 43, idAsString }] } },
      {}, async (api, taskbar) => {
        const r = await api.setWindowClass(43, 'rozelynx-facebook', 'Facebook');
        ok(r.ok, '8.1 setWindowClass reaches the component' + label, JSON.stringify(r));
        eq(taskbar.calls.map(c => c.method), ['setWindowClass'],
          '8.2 ...exactly once' + label);
        eq(taskbar.calls[0].klass, 'rozelynx-facebook', '8.3 ...with the class' + label);
        eq(taskbar.calls[0].title, 'Facebook', '8.4 ...and the title' + label);
        eq(r.via, 'qi', '8.5 ...via the explicit QI when that works' + label);
      });
  }

  // The bug this section exists for. In the running browser the sandbox QI
  // refused mozIDOMWindowProxy and the component was never called at all. The
  // fix must not depend on that QI: the window is handed over and the IDL's
  // declared conversion does the work.
  {
    await withTaskbar(
      { sandbox: { windows: [{ id: 43, qiThrows: true }] } }, {},
      async (api, taskbar) => {
        const r = await api.setWindowClass(43, 'rozelynx-facebook', 'Facebook');
        ok(r.ok, '8.6 a sandbox QI that throws does not stop the call',
          JSON.stringify(r));
        eq(taskbar.calls.length, 1, '8.7 the component was reached anyway');
        eq(r.via, 'glue', '8.8 ...and the route is reported, not guessed at');
        const icon = await api.setWindowIconFromPath(43, '/tmp/x.png');
        ok(icon.ok, '8.9 setWindowIconFromPath shares the fix', JSON.stringify(icon));
        eq(icon.via, 'glue', '8.10 ...reporting the same route');
        eq(taskbar.calls.map(c => c.method),
          ['setWindowClass', 'setWindowIconFromPath'], '8.11 both reached it');
      });
  }

  // If the privileged conversion ALSO fails, the failure must name Gecko's own
  // reason. The old code reported "window is not a mozIDOMWindowProxy", which
  // described its own failed attempt rather than the real cause.
  {
    await withTaskbar(
      { sandbox: { windows: [{ id: 43, qiThrows: true }] },
        taskbar: { fail: 'NS_ERROR_FAILURE: not a browser window' } }, {},
      async (api) => {
        const r = await api.setWindowClass(43, 'x', '');
        eq(r.ok, false, '8.12 a component failure is {ok:false}');
        ok(/not a browser window/.test(r.error || ''),
          '8.13 ...carrying the component\'s own message', r.error);
        ok(!/mozIDOMWindowProxy/.test(r.error || ''),
          '8.14 ...and not blaming the QI it tried first', r.error);
      });
  }

  // The old code caught the QI's exception and returned its OWN sentence,
  // "window is not a mozIDOMWindowProxy: <id>", discarding `e`. That sentence
  // is the entire content of the live diagnostic ring for this failure, and it
  // reads like the platform reporting that the object is not a
  // mozIDOMWindowProxy when it is this file asserting it on the platform's
  // behalf - which is why "why is the sandbox QI refused?" had no answer to
  // read. No such string exists anywhere in the 156.0.1 sources; the throw's
  // own text is now carried instead.
  {
    await withTaskbar(
      { sandbox: { windows: [{ id: 43, qiThrows: true }] } }, {},
      async (api) => {
        const r = await api.setWindowClass(43, 'x', '');
        ok(r.ok, '8.16 a glue conversion still succeeds', JSON.stringify(r));
        ok(/NS_ERROR_NO_INTERFACE/.test(r.qiError || ''),
          "8.17 ...carrying the QI's own reason", JSON.stringify(r));
        ok(!/is not a mozIDOMWindowProxy/.test(JSON.stringify(r)),
          '8.18 ...and not the old hand-written sentence instead',
          JSON.stringify(r));
      });
  }

  {
    await withTaskbar({ sandbox: { windows: [{ id: 43 }] } }, {},
      async (api) => {
        const r = await api.setWindowClass(43, 'x', '');
        ok(r.ok, '8.19 a working QI still succeeds', JSON.stringify(r));
        eq(r.via, 'qi', '8.20 ...via the QI');
        ok(!('qiError' in r),
          '8.21 ...and reports no reason, because there was none to report',
          JSON.stringify(r));
      });
  }

  // Once, not per launch. Two throwing QIs in one module load produce one line:
  // this is a permanent property of the sandbox, and a PWA launch must not cost
  // a log line each time. The reason still has to be IN that one line.
  {
    const warns = [];
    const rec = { log() {}, info() {}, error() {}, debug() {},
                  warn(...a) { warns.push(a.join(' ')); } };
    await withTaskbar(
      { sandbox: { windows: [{ id: 43, qiThrows: true }], console: rec } }, {},
      async (api) => {
        await api.setWindowClass(43, 'x', '');
        await api.setWindowIconFromPath(43, '/tmp/x.png');
      });
    eq(warns.length, 1, '8.22 two failing QIs, one warning');
    ok(/mozIDOMWindowProxy/.test(warns[0] || '') &&
         /NS_ERROR_NO_INTERFACE/.test(warns[0] || ''),
      '8.23 ...and it names both the interface and the reason', warns[0]);
  }

  // A JS `catch` cannot assume an Error, and XPConnect is not obliged to throw
  // one. "undefined" here would be worse than the old sentence: it would look
  // like an answer.
  {
    await withTaskbar(
      { sandbox: { windows: [{ id: 43, qiThrowsRaw: 'bare string throw' }] } },
      {}, async (api) => {
        const r = await api.setWindowClass(43, 'x', '');
        ok(r.ok, '8.24 a non-Error throw still converts', JSON.stringify(r));
        eq(r.qiError, 'bare string throw',
          '8.25 ...and the reason survives it', JSON.stringify(r));
      });
  }

  // The fallback route must actually match. It used to compare
  // `w.windowID === windowId`, which is the legacy DOM string against a number
  // and so could never be true - the branch was dead code.
  {
    const dir = fs.mkdtempSync(path.join(scratch, 'rz-win-fallback-'));
    const sb = makeSandbox({ tmpDir: dir });
    // No getOuterWindowWithId hit: the only window has a different id, so the
    // enumerator is what has to find it.
    const win = new FakeChromeWindow(43, { idAsString: true });
    sb.windows.length = 0;
    sb.windows.push(win);
    sb.Services.wm.getOuterWindowWithId = () => null;
    const taskbar = new FakeTaskbar();
    sb.Cc['@bytewheel.org/pwa/linux-taskbar;1'] = {
      getService: () => taskbar,
    };
    const api = loadApi(EXT, sb);
    const r = await api.setWindowClass(43, 'x', '');
    ok(r.ok, '8.15 the enumerator fallback matches on outerWindowID',
      JSON.stringify(r));
    eq(taskbar.calls.length, 1, '8.16 ...and reaches the component');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // And the old comparison is proven not to match, so the fix is not cosmetic.
  {
    const dir = fs.mkdtempSync(path.join(scratch, 'rz-win-oldcmp-'));
    const sb = makeSandbox({ tmpDir: dir });
    const win = new FakeChromeWindow(43, { idAsString: true });
    ok(String(win.windowID) !== String(43),
      '8.17 window.windowID is not the WebExtension window id');
    ok(win.windowID !== 43,
      '8.18 ...and never === a numeric id, which is why the old branch was dead');
    eq(String(win.docShell.outerWindowID), '43',
      '8.19 docShell.outerWindowID IS it');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // A window that is simply not there is still "window not found".
  {
    await withTaskbar({ sandbox: { windows: [] } }, {}, async (api, taskbar) => {
      const r = await api.setWindowClass(999, 'x', '');
      eq(r.ok, false, '8.20 an unknown window is {ok:false}');
      ok(/window not found/.test(r.error || ''), '8.21 ...naming the reason', r.error);
      eq(taskbar.calls.length, 0, '8.22 ...and the component is not called');
    });
  }

  // The other window helpers must still resolve through the new route.
  {
    await withTaskbar({ sandbox: { windows: [{ id: 7 }] } }, {}, async (api) => {
      const m = await api.setSsbMode(7, true);
      ok(m.ok, '8.23 setSsbMode still resolves the window', JSON.stringify(m));
      eq(await api.setSsbMode(8, true).then(r => r.ok), false,
        '8.24 ...and still refuses one that is not there');
    });
  }
}

/* 9 --------------------------------------------------------------- */

async function section9() {
  const entry = '[Desktop Entry]\nType=Application\nName=Demo\n';
  const { sb, api } = fresh();
  const apps = path.join(sb.home, '.local/share/applications');

  eq((await api.hasDesktopEntry('a.desktop')).exists, false,
    '9.1 absent before anything is written');

  const w = await api.writeDesktopEntry('a.desktop', entry);
  ok(w.ok, '9.2 the entry writes', JSON.stringify(w));
  const h = await api.hasDesktopEntry('a.desktop');
  ok(h.ok, '9.3 hasDesktopEntry answers');
  eq(h.exists, true, '9.4 ...and reports it is there');
  eq(h.path, w.path, '9.5 ...at the same path the writer used');
  eq(h.name, 'a.desktop', '9.6 ...under the same name');

  await api.removeDesktopEntry('a.desktop');
  eq((await api.hasDesktopEntry('a.desktop')).exists, false,
    '9.7 and absent again after a remove');

  // The three must agree about the name, or reconcile writes one file and
  // looks for another.
  {
    const name = '../../weird name.desktop';
    const wr = await api.writeDesktopEntry(name, entry);
    ok(wr.ok, '9.8 a traversal name is contained by the writer', JSON.stringify(wr));
    const hr = await api.hasDesktopEntry(name);
    eq(hr.name, wr.name, '9.9 hasDesktopEntry agrees on the sanitised name');
    eq(hr.exists, true, '9.10 ...and finds what the writer created');
  }
  // writer and reader must compute the SAME name from the SAME input, which is
  // the whole reason reconcile can ask "is it there?" and trust the answer.
  // (Case is deliberately preserved, not folded: both go through the same
  // sanitiser and the caller always passes the same derived string, so a
  // differently-cased query is a different file by design.)
  {
    const name = 'rozelynx-pwa-my_app-pwa-1.desktop';
    const wr = await api.writeDesktopEntry(name, entry);
    const hr = await api.hasDesktopEntry(name);
    eq(hr.name, wr.name, '9.11 writer and reader agree on the file name');
    eq(hr.exists, true, '9.12 ...for the name the caller actually passes');
    const wrong = await api.hasDesktopEntry('ROZELYNX-PWA-MY_APP-PWA-1.desktop');
    eq(wrong.exists, false, '9.13 case is not folded, by design');
  }

  eq((await api.hasDesktopEntry('...')).ok, false,
    '9.14 a name that sanitises to nothing is refused');
  eq((await api.hasDesktopEntry(null)).ok, false,
    '9.15 a null name is refused');

  // XDG_DATA_HOME is honoured for the read too, or reconcile would look in the
  // wrong directory and rewrite every entry on every start.
  {
    const probe = '/tmp/rz-xdg-has-' + process.pid;
    fs.rmSync(probe, { recursive: true, force: true });
    const x = fresh({ env: { XDG_DATA_HOME: probe } });
    const wr = await x.api.writeDesktopEntry('a.desktop', entry);
    const hr = await x.api.hasDesktopEntry('a.desktop');
    ok(hr.ok && hr.path.startsWith(probe), '9.16 the read honours XDG_DATA_HOME', hr.path);
    eq(hr.exists, true, '9.17 ...and finds the entry there');
    ok(wr.ok, '9.18 the write did too');
    fs.rmSync(probe, { recursive: true, force: true });
  }

  // A Home that cannot be resolved is a named failure, not an exception.
  {
    const broken = fresh();
    broken.sb.Services.dirsvc.get = () => { throw new Error('no Home'); };
    const r = await broken.api.hasDesktopEntry('a.desktop');
    eq(r.ok, false, '9.19 an unresolvable Home is {ok:false}');
    ok(/Home/.test(r.error || ''), '9.20 ...naming the lookup', r.error);
  }
}


/* 10 -------------------------------------------------------------- */

async function section10() {
  // The schema and the implementation have to declare the same set of
  // functions, and hasDesktopEntry has to be APPENDED - every other part of
  // this plan re-asserts that invariant for this file.
  const schema = JSON.parse(fs.readFileSync(
    path.join(EXT, 'lib/experiments/windows-schema.json'), 'utf8'));
  const ns = schema.find(s => s.namespace === 'rozelynxWindows');
  ok(!!ns, '10.1 the rozelynxWindows namespace is declared');
  eq(ns.functions.map(f => f.name), [
    'setSsbMode', 'setSsbTabs', 'setPrefersColorScheme', 'getProfilePath',
    'isTaskbarAvailable', 'setWindowClass', 'writeIconFile',
    'setWindowIconFromPath', 'writeDesktopEntry', 'removeDesktopEntry',
    'hasDesktopEntry', 'ssbHandlerStatus',
  ], '10.2 the function list is the expected twelve, in order, nothing displaced');

  // The implementation must define every one the schema declares. This is the
  // "the editor says saved and nothing happened" shape: a schema entry with no
  // implementation is an API that silently does not exist.
  const dir = fs.mkdtempSync(path.join(scratch, 'rz-win-schema-'));
  const sb = makeSandbox({ tmpDir: dir });
  const api = loadApi(EXT, sb);
  for (const f of ns.functions) {
    ok(typeof api[f.name] === 'function',
      '10.3 ' + f.name + ' is implemented', typeof api[f.name]);
  }
  eq(Object.keys(api).sort(), ns.functions.map(f => f.name).sort(),
    '10.4 and there is nothing implemented that the schema does not declare');
  fs.rmSync(dir, { recursive: true, force: true });

  // Every function entry must also be well FORMED, not merely present on both
  // sides. This is the gap that let ssbHandlerStatus ship without "parameters":
  // 10.3 and 10.4 both passed, because the implementation existed and the schema
  // declared the name, and yet every call rejected with
  // "InvalidStateError: An exception was thrown by the handler." Gecko builds the
  // call wrapper by iterating schema.parameters, so a function entry that omits
  // it is not callable at all - and the failure is reported as if the PARENT
  // had thrown, which sent the diagnosis after the implementation instead of
  // after the schema. Two checks, because the two omissions fail differently.
  for (const f of ns.functions) {
    ok(Array.isArray(f.parameters),
      '10.5 ' + f.name + ' declares its parameters', typeof f.parameters);
    ok(f.async === true,
      '10.6 ' + f.name + ' is declared async, as the parent implementation is', f.async);
  }
  eq(ns.functions.filter(f => !Array.isArray(f.parameters)).map(f => f.name), [],
    '10.7 no function entry is missing "parameters"');
}

/* 11 -------------------------------------------------------------- */

async function section11() {
  // The --ssb handler probe (G.9). This is a diagnostic, so the property that
  // matters is that it REPORTS: a probe that swallowed the exception would leave
  // us exactly where we were, which is a handler silently skipped by Gecko's
  // dispatch with the reason in a console nobody opens.
  const CONTRACT = '@mozilla.org/browser/ssb/clh;1';

  // FakeTaskbar-style: a component that answers, and one that is absent.
  const withSvc = async (svc, fn) => {
    const dir = fs.mkdtempSync(path.join(scratch, 'rz-win-ssb-'));
    try {
      const sb = makeSandbox({ tmpDir: dir });
      sb.Ci.nsICommandLineHandler = { name: 'nsICommandLineHandler' };
      if (svc) sb.Cc[CONTRACT] = { getService: () => svc };
      const api = loadApi(EXT, sb);
      return await fn(api, sb);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  // The exact contract Gecko's dispatch looks up. Asking for anything else would
  // report "unavailable" and be believed.
  {
    let asked = null;
    await withSvc({ classDescription: 'RozeLynx SSB Command Line Handler' },
      async (api, sb) => {
        sb.Cc[CONTRACT] = { getService: (i) => { asked = i; return { classDescription: 'RozeLynx SSB Command Line Handler' }; } };
        const r = await api.ssbHandlerStatus();
        ok(r.ok, '11.1 the probe answers ok either way');
        ok(r.available, '11.2 ...and reports available when the contract resolves');
        eq(r.contract, CONTRACT, '11.3 ...naming the contract it asked for');
        eq(asked, sb.Ci.nsICommandLineHandler,
          '11.4 ...and it asked for nsICommandLineHandler, not something else');
        eq(r.classDescription, 'RozeLynx SSB Command Line Handler',
          '11.5 ...and the class describes itself, so a wrong class is visible');
      });
  }

  // The reason must SURVIVE. This is the whole point: Gecko logs
  // "could not be created" and continues, so the diagnosis exists only if the
  // probe passes the exception on.
  {
    await withSvc(null, async (api) => {
      const r = await api.ssbHandlerStatus();
      ok(r.ok, '11.6 an absent component is still {ok:true} - it is a fact, not a failure');
      eq(r.available, false, '11.7 ...reporting unavailable');
      ok(typeof r.error === 'string' && r.error.length > 0,
        '11.8 ...with the reason attached, not silently empty', JSON.stringify(r));
      // The check is "not a useless placeholder", NOT "does not mention
      // undefined" - a real TypeError legitimately says
      // "Cannot read properties of undefined (reading 'getService')", and
      // rejecting that would be rejecting the answer.
      ok(r.error !== 'undefined' && r.error !== 'null' && r.error.length > 1,
        '11.9 ...and the reason is a real message, not a stringified undefined',
        r.error);
    });
  }

  // A component that exists but throws must not be reported as available.
  {
    await withSvc(null, async (api, sb) => {
      sb.Cc[CONTRACT] = { getService: () => { throw new Error('NS_ERROR_FAILURE: module threw'); } };
      const r = await api.ssbHandlerStatus();
      eq(r.available, false, '11.10 a throwing getService is unavailable');
      ok(/module threw/.test(r.error || ''),
        '11.11 ...carrying what the module actually said', r.error);
    });
  }

  // classDescription must not be able to turn a present handler into a failure.
  {
    await withSvc(null, async (api, sb) => {
      sb.Cc[CONTRACT] = { getService: () => ({
        get classDescription() { throw new Error('nope'); },
      }) };
      const r = await api.ssbHandlerStatus();
      ok(r.available, '11.12 a classDescription that throws does not hide the handler');
      ok(/classDescription threw/.test(r.classDescription || ''),
        '11.13 ...and says that is what happened', r.classDescription);
    });
  }
}


/* 12 -------------------------------------------------------------- */

/* The declared media type is whatever a server said, and servers say
 * application/octet-stream to perfectly good PNGs. 1.0.72's writer refused
 * exactly that payload and the caller's entry fell back to the theme-name
 * icon, so the fix this section exists for is: the EXTENSION comes from the
 * bytes, the declaration only names the refusal. */
async function section12() {
  const { sb, api } = fresh();
  const icons = path.join(sb.profd, 'pwa-icons');

  // Real signatures, because the point is that a *recognisable* payload
  // survives a lying Content-Type. A fake signature that the sniff would
  // only match because it was invented for the check is the fake agreeing
  // with the code again.
  const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const r = await api.writeIconFile(
    'data:application/octet-stream;base64,' + png.toString('base64'), 'pwa-a');
  ok(r.ok, '12.1 a PNG served as octet-stream is written', JSON.stringify(r));
  ok(r.path.endsWith('.png'), '12.2 ...under a .png name', r.path);
  ok(fs.readFileSync(path.join(icons, 'pwa-a.png')).equals(png),
    '12.3 ...with the bytes intact');

  const webp = Buffer.alloc(12);
  webp.write('RIFF', 0, 'ascii');   // bytes 0-3: 'RIFF'
  webp.write('WEBP', 8, 'ascii');    // bytes 8-11: 'WEBP' (VP8 in 12..)
  const w = await api.writeIconFile(
    'data:text/plain;base64,' + webp.toString('base64'), 'pwa-b');
  ok(w.ok && w.path.endsWith('.webp'),
    '12.4 a WEBP sniffed through a text/plain declaration', JSON.stringify(w));

  const ico = Buffer.from([0x00, 0x00, 0x01, 0x00]);
  const i = await api.writeIconFile(
    'data:application/octet-stream;base64,' + ico.toString('base64'), 'pwa-c');
  ok(i.ok && i.path.endsWith('.ico'),
    '12.5 an ICO is sniffed by its 00 00 01 00 prefix', JSON.stringify(i));

  const bmp = Buffer.alloc(2);
  bmp.write('BM', 0, 'ascii');
  const bm = await api.writeIconFile(
    'data:application/octet-stream;base64,' + bmp.toString('base64'), 'pwa-d');
  ok(bm.ok && bm.path.endsWith('.bmp'),
    '12.6 a BMP is sniffed by its "BM"', JSON.stringify(bm));

  // SVG is the one text format: an XML prolog precedes the <svg, and the
  // sniff tolerates exactly that shape - no whitespace-only file with the
  // word svg in it.
  const svg = Buffer.from('<?xml version="1.0"?><svg xmlns="…"/>');
  const s = await api.writeIconFile(
    'data:application/octet-stream;base64,' + svg.toString('base64'), 'pwa-e');
  ok(s.ok && s.path.endsWith('.svg'),
    '12.7 an SVG is sniffed as text naming an <svg>', JSON.stringify(s));

  // Both legs failing is still a refusal, with the declared type in the
  // reason: the sniff must not turn the writer into "write anything".
  const junk = await api.writeIconFile(
    'data:application/octet-stream;base64,' + Buffer.from('not an image at all')
      .toString('base64'), 'pwa-f');
  eq(junk.ok, false, '12.8 bytes nobody recognises are refused');
  ok(/octet-stream/.test(junk.error || ''),
    '12.9 ...and the reason names what was declared', junk.error);
  eq((await api.writeIconFile(
    'data:text/html;base64,' + Buffer.from('<html><body>x</body></html>')
      .toString('base64'), 'pwa-g')).ok, false,
    '12.10 an HTML payload is not adopted as an icon by the sniff');
}

/* 13 -------------------------------------------------------------- */

/* The read half's second answer. The reconcile pass decides "present" vs
 * "upgrade" on exactly what this section asserts: the Icon= value, and
 * whether an absolute Icon= file is still there. */
async function section13() {
  const entry = [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Demo',
    'Exec=rozelynx --ssb https://x/',
    'Icon=%ICON%',
    '',
  ].join('\n');
  const { sb, api } = fresh();
  const apps = path.join(sb.home, '.local/share/applications');

  const w = await api.writeDesktopEntry('a.desktop',
    entry.replace('%ICON%', '/tmp/rz-no-such-icon.png'));
  ok(w.ok, '13.1 the entry writes', JSON.stringify(w));
  const h = await api.hasDesktopEntry('a.desktop');
  ok(h.ok && h.exists, '13.2 it is there', JSON.stringify(h));
  eq(h.icon, '/tmp/rz-no-such-icon.png',
    '13.3 the Icon= value is read back');
  eq(h.iconExists, false, '13.4 an absolute value is stat-ed, and is absent');

  // A theme NAME is not stat-ed: the DE resolves it, not the sandbox, so
  // the reply carries the value and no iconExists at all - which is the
  // distinction reconcile's "cannot be known" answer is built on.
  {
    const wb = await api.writeDesktopEntry('b.desktop',
      entry.replace('%ICON%', 'rozelynx'));
    ok(wb.ok, '13.5 the theme-name entry writes', JSON.stringify(wb));
    const h2 = await api.hasDesktopEntry('b.desktop');
    eq(h2.icon, 'rozelynx', '13.6 the theme NAME is reported as the value itself');
    eq('iconExists' in h2, false,
      '13.7 ...and is not stat-ed, so no iconExists field exists');
  }

  // A real file on the other side of the Icon= key.
  {
    const iconPath = path.join(scratch, 'live-icon.png');
    fs.writeFileSync(iconPath, Buffer.from([0x89, 0x50]));
    await api.writeDesktopEntry('c.desktop', entry.replace('%ICON%', iconPath));
    const h3 = await api.hasDesktopEntry('c.desktop');
    eq(h3.icon, iconPath, '13.8 a live absolute path round-trips');
    eq(h3.iconExists, true, '13.9 ...and is reported present');
  }

  // An entry with no Icon= key at all: an empty answer, not a throw.
  {
    await api.writeDesktopEntry('d.desktop', '[Desktop Entry]\nType=Application\n');
    const h4 = await api.hasDesktopEntry('d.desktop');
    eq(h4.exists, true, '13.10 an entry without Icon= is still an entry');
    eq(h4.icon, '', '13.11 ...whose read-back is an empty icon');
  }

  // The cap: a file at an entry's path that is not an entry must not be
  // dragged through a string, it must answer "cannot be known" (no fields)
  // while still answering the primary question.
  {
    const name = await api.writeDesktopEntry('e.desktop', entry.replace('%ICON%', 'x'))
      .then(r => r.name);
    const p = path.join(apps, name);
    fs.writeFileSync(p, Buffer.alloc((1 << 20) + 16, 0x41));
    const h5 = await api.hasDesktopEntry('e.desktop');
    ok(h5.ok && h5.exists, '13.12 an oversized file at the path is still there',
      JSON.stringify(h5));
    eq('icon' in h5, false, '13.13 ...and reports no icon field');
    eq('iconExists' in h5, false, '13.14 ...and no iconExists either');
  }

  // XDG_DATA_HOME is honoured by the read too (9.16 asserts the pre-1.0.73
  // half; this is the same rule through the new fields).
  {
    const probe = '/tmp/rz-xdg-has13-' + process.pid;
    fs.rmSync(probe, { recursive: true, force: true });
    const x = fresh({ env: { XDG_DATA_HOME: probe } });
    await x.api.writeDesktopEntry('a.desktop', entry.replace('%ICON%', '/tmp/x.png'));
    const hx = await x.api.hasDesktopEntry('a.desktop');
    eq(hx.icon, '/tmp/x.png', '13.15 the read-back honours XDG_DATA_HOME');
    fs.rmSync(probe, { recursive: true, force: true });
  }
}

run('rozelynx-windows-api', async () => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-winapi-'));
  try {
    for (const [n, name, fn] of SECTIONS) await step(n, name, fn);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
});
