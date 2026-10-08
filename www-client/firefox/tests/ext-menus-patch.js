#!/usr/bin/env node
'use strict';
/* Harness for the extension-menus patch (2026-09-30).
 *
 * Why this exists. The synthetic context-menu section in the gesture menu had
 * been empty since it was written, and every explanation available from the
 * page was the same shape: an empty panel. The obvious readings were all
 * wrong - not "awaiting a build" (the patch is applied unconditionally and the
 * methods are in the shipped browser), and not "unimplemented" (they exist).
 * A live probe settled it: rozelynxQuery is present and rejects on every call.
 *
 * What it rejected on is the part this harness exists to prevent coming back.
 * The query decided "is this a submenu" with
 *
 *     menuItem.parent && menuItem.parent.id !== menuItem.root.id
 *
 * and `root` is not a plain read: its getter lazily CONSTRUCTS a root MenuItem
 * when gRootItems has no entry for the extension, and that constructor assigns
 * an id via `gMenuMap.get(ext).has(id)`, which throws for any extension with no
 * gMenuMap entry. So the single expression that classified items was also the
 * only code in the query able to throw - and it sat inside no try, so one such
 * item discarded the whole list.
 *
 * The fix is to stop reading `.root` at all: parentId comes from the item's own
 * getter, and whether the parent is a real item is answered from the map
 * already in hand, because the synthesized root is not in it.
 *
 * Asserted here, on the patch text rather than on a build (no compiled browser
 * is available in the test environment):
 *
 *   1. no line the patch ADDS reads `.root` - stock MenuItem code uses it, so
 *      this must look only at added lines, or it fails on code nobody touched;
 *   2. every per-item read sits inside a try, and the catch does not swallow
 *      the failure silently, because silence is what made this undiagnosable;
 *   3. both methods are declared in the schema hunk, since a patch whose
 *      implementation applies but whose schema hunk does not yields an API that
 *      is invisible rather than absent;
 *   4. the patch's hunk headers agree with their bodies. A unified diff whose
 *      counts are wrong is rejected wholesale by patch(1), which would look
 *      exactly like "the feature was never wired up".
 */

const fs = require('fs');
const path = require('path');
const { ok, eq, run } = require('./lib/check.js');
const { OVERLAY } = require('./lib/roots.js');

const PATCH = path.join(
  path.dirname(require.resolve('./lib/roots.js')), '..', '..',
  'files/rozelynx/dev/ext-menus-rozelynx.patch');

const raw = fs.readFileSync(PATCH, 'utf8');
const lines = raw.split('\n');

// Added lines only, and per file section so the schema hunk can be told apart
// from the implementation hunk.
const sections = [];
let cur = null;
for (const l of lines) {
  if (/^diff -ruN /.test(l)) { cur = { file: l.split(/\s+/).pop(), added: [], body: [] }; sections.push(cur); continue; }
  if (!cur) continue;
  cur.body.push(l);
  if (l.startsWith('+') && !l.startsWith('+++')) cur.added.push(l);
}
const impl = sections.find(s => /ext-menus\.js$/.test(s.file));
const schema = sections.find(s => /menus\.json$/.test(s.file));

run('extension menus patch', () => {
  ok(impl && schema, 'patch covers both the implementation and the schema',
    `sections: ${sections.map(s => s.file.split('/').pop()).join(', ')}`);

  // ── 1. no added line may read `.root` ──
  const rootReads = impl.added.filter(l => /\.\s*root\b/.test(l) && !/^\+\s*\/\//.test(l));
  ok(rootReads.length === 0,
    'no added line reads .root (its getter constructs a root, which can throw)',
    rootReads.length ? rootReads.join(' | ') : `${impl.added.length} added lines checked`);

  // ── 2. per-item reads are guarded, and the guard is not silent ──
  // Comment lines are blanked before matching CODE SHAPE. The catch block that
  // reports the failure is preceded by a comment explaining why it reports, and
  // the first version of this check failed on a correct patch for that reason -
  // the same mistake as reading the CSS rule-by-rule instead of parsing it.
  const code = impl.added
    .map(l => l.slice(1))                        // drop the diff's own '+'
    .map(l => (/^\s*\/\//.test(l) ? '' : l))    // blank out comment lines
    .join('\n');
  const addedText = code;
  ok(/catch \(e\) \{[^{}]*console\./.test(addedText),
    'a catch block reports rather than swallowing the failure',
    'an item that throws must not empty the section quietly');

  // `if (!menuItem.enabledForContext(fake))` inside a try, rather than a bare
  // `applies = ...` guarded by its own catch: the old shape left the results
  // mapping outside any guard, which is where the throw actually happened.
  ok(/try \{\s*if \(!menuItem\.enabledForContext\(fake\)\) \{\s*continue;/.test(
       addedText),
    'the filter and the results mapping share one try',
    'a throw while building an entry must cost that entry, not the query');

  ok(!/catch \(e\) \{\s*\}/.test(addedText),
    'no empty catch block remains',
    'an empty catch is what hid the original failure');

  // ── 3. both methods declared in the schema hunk ──
  for (const name of ['rozelynxQuery', 'rozelynxTrigger']) {
    ok(schema.added.some(l => l.includes(`"${name}"`)),
      `schema declares ${name}`,
      'an implementation without its schema entry yields an invisible API');
  }

  // ── 4. hunk headers agree with their bodies ──
  let checked = 0;
  for (const s of sections) {
    for (let i = 0; i < s.body.length; i++) {
      const m = s.body[i].match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
      if (!m) continue;
      checked++;
      let oldCnt = 0, newCnt = 0, j = i + 1;
      for (; j < s.body.length; j++) {
        const b = s.body[j];
        if (/^@@|^diff |^--- |^\+\+\+ /.test(b)) break;
        if (b.startsWith(' ') || b.startsWith('-')) oldCnt++;
        if (b.startsWith(' ') || b.startsWith('+')) newCnt++;
      }
      const oldWant = m[2] === undefined ? 1 : Number(m[2]);
      const newWant = m[4] === undefined ? 1 : Number(m[4]);
      eq(oldCnt, oldWant, `hunk ${checked} of ${s.file.split('/').pop()}: old line count`);
      eq(newCnt, newWant, `hunk ${checked} of ${s.file.split('/').pop()}: new line count`);
    }
  }
  ok(checked > 0, 'hunk headers were parsed', `${checked} hunk(s)`);
});