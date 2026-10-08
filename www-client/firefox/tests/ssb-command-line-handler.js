#!/usr/bin/env node
'use strict';
/* Harness for the --ssb command-line handler: files/rozelynx/cpp/pwa-linux-taskbar/
 * SsbCommandLineHandler.sys.mjs, loaded verbatim as the ES module it is.
 *
 * Why this exists (PLAN-SESSION-20, G.7, 2026-09-28). This file is what makes
 * clicking a generated .desktop entry do anything, and **no harness in tests/
 * touched it** - `grep -rl SsbCommandLineHandler tests/` is empty. B.2.2's "17
 * checks" and B.4's "54 checks" over the handler were run from /tmp and never
 * moved into the repo, which Part H records as the general fate of this
 * project's harnesses. So the two defects that made the feature a complete
 * no-op shipped with nothing to catch them:
 *
 *   - `cmdLine.preventDefault = true;` - an ASSIGNMENT where a CALL was meant.
 *     On an XPCOM wrapper that is silently a no-op, so the handler never claimed
 *     the command line and the browser opened its own default window anyway.
 *   - `openWindow({ args: [string], ... })` - `args` must be a single
 *     nsISupportsString (nsIWindowWatcher.openWindow's parameter is
 *     [in] nsISupportsString, and upstream's BrowserWindowTracker builds one),
 *     so the array threw NS_ERROR_XPC_BAD_CONVERT and the window never opened.
 *
 * Together they produced the live report "opens a new browser window, but does
 * no navigation". The two checks that would have caught them are 1.x below, and
 * they are written against the *contract* rather than against a convenient
 * stub: the BrowserWindowTracker here reproduces 156.0.1's real
 * openWindow(options) destructuring, and the nsIWindowWatcher stub REFUSES
 * anything that is not an nsISupportsString, exactly as XPConnect does.
 *
 * A THIRD defect then survived all 19 of those checks, and the reason is worth
 * recording because it is a lesson about fakes rather than about this handler.
 * Gecko hands a command line handler an nsICommandLineHandlerParams, which has
 * exactly three members - handle(), handleFlag(), handleFlagWithParam(). The
 * handler was calling cmdLine.preventDefault(), cmdLine.length and
 * cmdLine.getArgument(), none of which exist on it: they are nsICommandLine
 * members. preventDefault() threw on the first statement after the claim, so
 * handle() aborted, the line was never claimed, and Gecko's default handler
 * opened the leftovers as URLs - which is the actual live symptom, two ordinary
 * tabs, https://github.com/ and http://rozelynx-github/ (the unconsumed
 * --ssb-class value read as a bare hostname). Nothing was wrong with the
 * contract, the category registration or the component: a probe added to the
 * extension confirmed the service was reachable and the class was the right
 * one, which is what finally moved the diagnosis off registration and onto this
 * file.
 *
 * It survived because the fake cmdLine here was a plain object that HELPFULLY
 * carried preventDefault, length and getArgument - a stub shaped to fit the code
 * under test, so the code was correct in the harness's world and broken in
 * Gecko's. The fake now models the real interface: the three methods that exist
 * and nothing else, so reaching for a fourth is a TypeError here exactly as it
 * is in the browser. The 0.x checks below assert that absence deliberately, and
 * reintroducing the shipped defect makes this harness fail with the same
 * "cmdLine.preventDefault is not a function" the browser gave - which is the
 * check that had been missing all along.
 */

/* The handler is an ES module, so it needs vm.SourceTextModule. Re-exec with the
 * flag rather than making every caller in run.sh remember it. */
if (typeof require('vm').SourceTextModule !== 'function') {
  const { spawnSync } = require('child_process');
  const r = spawnSync(process.execPath,
    // --no-warnings: the ExperimentalWarning for vm modules goes to stderr and
    // run.sh parses this harness's LAST line, so it would be read as the summary.
    ['--experimental-vm-modules', '--no-warnings', __filename, ...process.argv.slice(2)],
    { stdio: 'inherit' });
  process.exit(r.status === null ? 2 : r.status);
}

const fs = require('fs');
const path = require('path');
const vm = require('vm');
const { ok, eq, run } = require('./lib/check.js');
const { root, requireTree } = require('./lib/roots.js');

/* The handler ships in the package's cpp/ tree, not in the extension, so it is
 * resolved the same way the host is: from the overlay source of truth, not from
 * whatever extension tree argv names. RZ_TEST_ROOT may point it elsewhere. */
function handlerPath() {
  const fromEnv = process.env.RZ_HANDLER;
  if (fromEnv) return fromEnv;
  const overlay = path.join(
    path.dirname(require.resolve('./lib/roots.js')), '..', '..');
  return path.join(overlay, 'files/rozelynx/cpp/pwa-linux-taskbar/SsbCommandLineHandler.sys.mjs');
}
const HANDLER = handlerPath();

class FakeSupportsString {
  constructor() { this.data = ''; }
}

/* One invocation of the handler, with everything it touches recorded. */
async function runHandler(argv, opts = {}) {
  const rec = {
    handleCalled: 0,
    opened: null,
    convertError: null,
    navigated: null,
    focused: 0,
    taskbar: [],
    errors: [],
    existingSSB: opts.existingSSB || [],
    docReadyState: opts.docReadyState || 'complete',
  };

  /* A faithful nsICommandLineHandlerParams.
   *
   * This fake used to be a plain object carrying `length`, `getArgument()` and
   * `preventDefault()`. None of those three exist on nsICommandLineHandlerParams
   * - the interface has exactly handle(), handleFlag() and handleFlagWithParam().
   * They are nsICommandLine members, and a command line handler is handed the
   * PARAMS object, not the command line. By supplying them, the fake made the
   * real defect invisible: the handler called cmdLine.preventDefault(), the fake
   * counted it, and 19 checks passed while every live launch produced two
   * ordinary tabs. The handler was not wrong in the harness's world.
   *
   * So the fake now models the real interface: the three methods that exist, and
   * NOTHING else. Calling anything else is a TypeError here exactly as it is in
   * Gecko, which is the property that makes this harness able to catch the next
   * one. `handleCalled` replaces `preventDefaultCalls`, because handle() is what
   * actually claims the line.
   */
  const cmdLine = {
    handle() { rec.handleCalled++; },
    handleFlag(name) {
      // nsICommandLineHandlerParams.handleFlag throws for a flag that takes a
      // param, and returns true for a boolean flag. The handler passes `false`
      // as the default so a missing flag is falsy.
      if (argv.includes('--' + name)) return true;
      return null;
    },
    handleFlagWithParam(name) {
      const i = argv.indexOf('--' + name);
      return i >= 0 && i + 1 < argv.length ? argv[i + 1] : null;
    },
  };

  // Belt and braces: name the members that must NOT be reachable, so a future
  // edit that reaches for one fails as a clear message rather than as a mystery.
  for (const forbidden of ['preventDefault', 'length', 'getArgument', 'arguments']) {
    ok(!(forbidden in cmdLine),
      '0.x the fake does not offer "' + forbidden + '", which the real interface lacks');
  }

  const makeWin = (ssbMode) => ({
    document: {
      readyState: rec.docReadyState,
      documentElement: {
        getAttribute: (a) => (a === 'ssb-mode' ? ssbMode : null),
        setAttribute: (a, v) => { if (a === 'ssb-mode') rec.ssbAttr = v; },
      },
    },
    gBrowser: { selectedBrowser: {
      loadURI: (u) => { rec.navigated = u; },
    } },
    focus: () => { rec.focused++; },
  });

  // Every window the handler can enumerate, built here so focus() and
  // loadURI() are recorded. `existingSSB` is a list of booleans: true means that
  // window already has ssb-mode="true" and is therefore a reuse candidate.
  const newWin = makeWin(null);
  rec.existing = rec.existingSSB.map((isSsb) => makeWin(isSsb ? 'true' : null));
  const bwt = {
    // 156.0.1 browser/modules/BrowserWindowTracker.sys.mjs:336, openWindow
    // (options = {}), reproduced including the defaultArgs substitution.
    openWindow(options = {}) {
      let { features = undefined, all = true, args = null } = options;
      let windowFeatures = 'chrome,dialog=no';
      if (all) windowFeatures += ',all';
      if (features) windowFeatures += ',' + features;
      if (!args) {
        args = new FakeSupportsString();
        args.data = '<defaultArgs>';
      }
      // nsIWindowWatcher.openWindow(parent, uri, name, features,
      // [in] nsISupportsString args) - anything else is a bad XPCOM convert.
      if (args == null || typeof args.data !== 'string') {
        rec.convertError = Array.isArray(args)
          ? 'Array(' + args.length + ') passed where nsISupportsString is required'
          : Object.prototype.toString.call(args);
        throw new Error('NS_ERROR_XPC_BAD_CONVERT: could not convert to nsISupportsString');
      }
      rec.opened = { args: args.data, windowFeatures };
      return newWin;
    },
  };

  const context = vm.createContext({
    console: { log() {}, warn() {}, error: (m) => rec.errors.push(String(m)),
               debug() {} },
    Ci: { nsISupportsString: 'nsISupportsString',
          nsIRozeLynxLinuxTaskbar: 'nsIRozeLynxLinuxTaskbar' },
    Cc: {
      '@mozilla.org/supports-string;1': { createInstance: () => new FakeSupportsString() },
      '@bytewheel.org/pwa/linux-taskbar;1': {
        getService: () => ({
          setWindowClass: (w, k) => rec.taskbar.push(['class', k]),
          setWindowIconFromPath: (w, p) => rec.taskbar.push(['icon', p]),
        }),
      },
    },
    ChromeUtils: { generateQI: () => ({}) },
    Services: {
      wm: {
        getEnumerator: () => {
          const ws = rec.existing.slice();
          return { hasMoreElements: () => ws.length > 0, getNext: () => ws.shift() };
        },
      },
    },
  });
  context.globalThis = context;
  context.setTimeout = (f) => { f(); return 0; };

  const src = fs.readFileSync(HANDLER, 'utf8');
  const mod = new vm.SourceTextModule(src, { context, identifier: 'SsbCommandLineHandler' });
  await mod.link(async (spec) => {
    if (spec.endsWith('BrowserWindowTracker.sys.mjs')) {
      return new vm.SyntheticModule(['BrowserWindowTracker'], function () {
        this.setExport('BrowserWindowTracker', bwt);
      }, { context });
    }
    if (spec.endsWith('Timer.sys.mjs')) {
      return new vm.SyntheticModule(['setTimeout'], function () {
        this.setExport('setTimeout', context.setTimeout);
      }, { context });
    }
    return new vm.SyntheticModule([], function () {}, { context });
  });
  await mod.evaluate();

  const ctor = mod.namespace.SSBCommandLineHandler;
  const H = ctor.prototype || ctor;
  await H.handle(cmdLine);
  return rec;
}

const PROFILE = '/home/u/.config/rozelynx/bytewheel/rozelynx/v1v89i7r.default-rozelynx';
const ICON = PROFILE + '/pwa-icons/pwa-55xu7q.png';
const fullArgv = (url, extra = []) => [
  'rozelynx', '--profile', PROFILE, '--ssb-class', 'rozelynx-github',
  '--ssb-icon', ICON, ...extra, '--ssb', url,
];

async function main() {
  requireTree(path.dirname(HANDLER), HANDLER);

  // -- the two defects ------------------------------------------------------
  {
    const r = await runHandler(fullArgv('https://github.com/'));
    eq(r.handleCalled, 1,
      '1.1 handle() CLAIMS the line, which is the only way to suppress the default window');
    eq(r.preventDefaultCalls, undefined,
      '1.2 ...and nothing was assigned to the property instead');
    eq(r.convertError, null,
      '1.3 openWindow got an nsISupportsString for args, not an Array', String(r.convertError));
    ok(r.opened, '1.4 a window was opened');
    eq(r.opened && r.opened.args, 'https://github.com/#rozelynx-pwa=1',
      '1.5 ...carrying the URL with the B.2.2 marker');
  }

  // -- the window features string ------------------------------------------
  {
    const r = await runHandler(fullArgv('https://github.com/'));
    const f = (r.opened && r.opened.windowFeatures) || '';
    // upstream already builds "chrome,dialog=no" and ",all"; the handler must
    // not add them again.
    eq((f.match(/chrome/g) || []).length, 1,
      '2.2 chrome appears once, not twice (upstream adds it already)', f);
    eq((f.match(/all/g) || []).length, 1,
      '2.3 all appears once, not twice (upstream adds it already)', f);
    eq((f.match(/dialog=no/g) || []).length, 1,
      '2.4 dialog=no appears once', f);
  }

  // -- nothing to do without --ssb -----------------------------------------
  {
    const r = await runHandler(['rozelynx', '--profile', PROFILE, 'https://example.com/']);
    eq(r.handleCalled, 0,
      '3.1 a command line without --ssb does not claim the line');
    eq(r.opened, null, '3.2 ...and opens no window');
  }

  // -- the reuse path ------------------------------------------------------
  {
    const r = await runHandler(fullArgv('https://github.com/'),
      { existingSSB: [false, true] });
    eq(r.focused, 1, '4.1 an existing SSB window is focused, not duplicated');
    eq(r.opened, null, '4.2 ...and no second window is opened');
    ok(/^https:\/\/github\.com\/#rozelynx-pwa=1$/.test(r.navigated || ''),
      '4.3 ...and it is navigated to the marked URL', String(r.navigated));
    eq(r.handleCalled, 1, '4.4 the reuse path claims the line too');
  }

  // -- the URL scan must not pick up a flag's value ------------------------
  {
    // --ssb-class given a URL-looking value: the real URL must still win.
    const argv = ['rozelynx', '--ssb-class', 'https://evil.example/x',
                  '--ssb', 'https://github.com/'];
    const r = await runHandler(argv);
    eq(r.opened && r.opened.args, 'https://github.com/#rozelynx-pwa=1',
      '5.1 a value-flag holding a URL is skipped in favour of the real one');
  }

  // -- the marker is stamped once -----------------------------------------
  {
    const r = await runHandler(fullArgv('https://github.com/#rozelynx-pwa=1'));
    eq(r.opened && r.opened.args, 'https://github.com/#rozelynx-pwa=1',
      '6.1 an already-marked URL is not marked twice');
    const r2 = await runHandler(fullArgv('https://github.com/#/route/x'));
    eq(r2.opened && r2.opened.args, 'https://github.com/#/route/x&rozelynx-pwa=1',
      '6.2 ...and an existing fragment is merged, not clobbered');
  }

  // -- the taskbar flags are read and applied ------------------------------
  {
    const r = await runHandler(fullArgv('https://github.com/'));
    ok(r.taskbar.some(t => t[0] === 'class' && t[1] === 'rozelynx-github'),
      '7.1 --ssb-class reaches the taskbar component', JSON.stringify(r.taskbar));
    ok(r.taskbar.some(t => t[0] === 'icon' && t[1] === ICON),
      '7.2 --ssb-icon reaches it too', JSON.stringify(r.taskbar));
  }
}

run('ssb-command-line-handler', main);
