'use strict';
/* The pass/fail recorder every harness uses.
 *
 * Two things it does that are worth having in one place rather than four:
 *
 *   - A recorded failure is never a crash. The first version of one harness
 *     dereferenced a value it had just asserted was present, so a mutation
 *     turned into a stack trace and the *other* 90 checks never ran. `ok()`
 *     records and returns; dereferencing is the caller's problem, and the
 *     guards are written with that in mind.
 *   - The summary is printed on exit even when the caller forgets, and the
 *     process exit code reflects it. A harness that dies before its summary
 *     must not look like a pass, so a hard exit is reported as such.
 */

const failures = [];
const notes_ = [];
let pass = 0;
let fail = 0;

/* A check that could not run, and said so. It is neither a pass nor a fail: it
 * is the outcome that is invisible unless it is written down, and a harness
 * that substitutes nothing for a missing tool and prints nothing has reported a
 * pass it did not earn. Printed in the summary so it cannot scroll past.
 *
 * This exists because the branding leg's tool-missing path and the
 * desktop-file-validate check both needed it, and a bare console.log in each
 * would be the same silence in two places. */
function note(msg) {
  notes_.push(msg);
}

/* Promises in a stubbed browser resolve as microtasks, so anything driven by a
 * sendMessage needs a turn of the loop before the DOM reflects the answer.
 * Every harness needs this and none of them should define it twice. */
const tick = () => new Promise(r => setImmediate(r));

function ok(cond, name, detail) {
  if (cond) {
    pass++;
    return true;
  }
  fail++;
  failures.push(name + (detail ? ' :: ' + detail : ''));
  return false;
}

function eq(got, want, name) {
  const g = JSON.stringify(got);
  const w = JSON.stringify(want);
  return ok(g === w, name, 'got ' + g + ' want ' + w);
}

/* Deep-equality for the cases JSON.stringify cannot see, chiefly objects whose
 * key order is not part of the answer and NaN/undefined distinctions. */
function same(a, b) {
  if (a === b) return true;
  if (typeof a !== typeof b) return false;
  if (a === null || b === null) return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (typeof a !== 'object') return Number.isNaN(a) && Number.isNaN(b);
  const ka = Object.keys(a).sort();
  const kb = Object.keys(b).sort();
  if (ka.length !== kb.length) return false;
  for (let i = 0; i < ka.length; i++) {
    if (ka[i] !== kb[i]) return false;
    if (!same(a[ka[i]], b[ka[i]])) return false;
  }
  return true;
}

function report(label) {
  console.log(`\n${label}: ${pass} passed, ${fail} failed`);
  if (notes_.length) {
    console.log('\nSKIPPED / NOTES:');
    notes_.forEach(n => console.log('  - ' + n));
  }
  if (fail) {
    console.log('\nFAILURES:');
    failures.forEach(f => console.log('  - ' + f));
  }
  return fail;
}

function summary() {
  return { pass, fail, failures: failures.slice(), notes: notes_.slice() };
}

let finished = false;
function finish(label, exit) {
  if (finished) return;
  finished = true;
  const bad = report(label);
  process.exitCode = exit ? 2 : (bad ? 1 : 0);
}

process.on('exit', () => {
  // A harness that never reached its own summary must not look like a pass.
  if (!finished) {
    report('ABORTED (the harness did not reach its summary)');
    process.exitCode = 2;
  }
});

/* Run an async main(), print the summary either way, and turn an exception
 * into a distinct exit code from a plain test failure. */
function run(label, main) {
  Promise.resolve()
    .then(main)
    .then(() => finish(label, false), (e) => {
      console.log('HARNESS ERROR: ' + (e && e.stack || e));
      finish(label, true);
    });
}

module.exports = { ok, eq, same, note, report, summary, run, finish, tick };
