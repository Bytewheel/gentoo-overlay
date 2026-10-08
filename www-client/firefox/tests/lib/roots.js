'use strict';
/* Where the trees are, and which one a harness is pointed at.
 *
 * Every harness takes a root as argv[2] and defaults to the overlay's source
 * of truth. The reason that argument exists at all is the property worth
 * keeping: the SAME harness file has to be able to test the source tree, a
 * freshly assembled extension, and the portage mirror's copy, because "what
 * ships is what was tested" is only a claim if the bytes that were tested are
 * the bytes that ship. A harness with a hardcoded path can only ever make that
 * claim about one of the three.
 */

const fs = require('fs');
const path = require('path');

const OVERLAY = path.join(__dirname, '..', '..', '..', '..');

/* The extension source tree: the one the ebuild hands to assemble-extension.py
 * as --extension-dir. */
const EXT_SRC = path.join(OVERLAY, 'www-client/firefox/files/rozelynx/extension');

/* The native messaging host, which lives beside the extension rather than in
 * it. */
const HOST_SRC = path.join(OVERLAY, 'www-client/firefox/files/rozelynx/host/rozelynx-host');

/* The portage mirror: what an emerge actually reads. */
const MIRROR = '/var/db/repos/bytewheel/www-client/firefox';

/* The patch-tree backup: what a re-apply of the template rebuilds from. */
const BACKUP = path.join(OVERLAY, 'scripts/firefox-librewolf');

/* Resolve the root a harness should test: argv wins, then $RZ_TEST_ROOT (so
 * run.sh can point every harness at one tree), then the overlay. */
function root(argv) {
  const fromArgv = (argv || []).slice(2).find(a => a && !a.startsWith('-'));
  return fromArgv || process.env.RZ_TEST_ROOT || EXT_SRC;
}

function hostPath(rootArgv) {
  // A harness pointed at an assembled extension has no host beside it, so the
  // host always comes from the source tree unless one is given outright.
  const explicit = (rootArgv || []).slice(2).find(a => a && a.endsWith('rozelynx-host'));
  return explicit || HOST_SRC;
}

/* Fail loudly rather than testing nothing: a harness pointed at a tree that
 * does not exist would otherwise report zero checks and exit 0, which is the
 * one outcome a test runner must never produce. */
function requireTree(dir, what) {
  if (!fs.existsSync(dir)) {
    console.error('FATAL: ' + (what || dir) + ' does not exist: ' + dir);
    console.error('Pass a tree as argv[2], or set RZ_TEST_ROOT.');
    process.exit(2);
  }
  return dir;
}

/* Assemble a fresh extension from the source tree, the way the ebuild does,
 * and return its path. Used by run.sh to prove the harnesses pass against the
 * build output as well as the sources. */
function assemble(outDir, features) {
  const { execFileSync } = require('child_process');
  fs.rmSync(outDir, { recursive: true, force: true });
  execFileSync('python3', [
    path.join(EXT_SRC, 'assemble-extension.py'),
    '--extension-dir', EXT_SRC,
    '--output-dir', outDir,
    '--enable', features || 'pwa,qr-code,net-iface,mouse-gestures,download-handoff',
  ], { stdio: 'pipe' });
  return outDir;
}

module.exports = { OVERLAY, EXT_SRC, HOST_SRC, MIRROR, BACKUP, root, hostPath, requireTree, assemble };
