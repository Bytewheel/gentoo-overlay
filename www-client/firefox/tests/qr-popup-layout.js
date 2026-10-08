#!/usr/bin/env node
'use strict';
/* Harness for the QR popup's centring contract (2026-09-30).
 *
 * Why this exists. The URL shown under the QR code is a BLOCK box with
 * `max-width: 260px`, and the body centres its content with
 * `text-align: center`. Those are two different things: `text-align` centres
 * INLINE content inside a block, it does not centre the block itself. The box
 * had no auto side margins, so it sat against the left padding - invisible
 * while the popup was only as wide as the QR canvas, and obvious as soon as it
 * was not, because expanding "Interface bindings by URL" or "Download
 * hand-off" puts flex text inputs and a select into the popup and the popup
 * widens to fit them. The canvas did not move because canvas is inline-level,
 * which is exactly why the report was "the URL moves, not the QR code".
 *
 * Nothing caught it because there was no harness for this file at all, and
 * because a CSS bug of this kind cannot be seen by exercising the module's
 * logic: the handler, the QR encoder and the URL text were all correct.
 *
 * The rule asserted here is the general one, not the one line: any element that
 * is a direct child of <body>, is block-level, and carries a max-width is being
 * used as centred content, so it must have auto side margins. That holds for
 * whatever art and markup arrives next, and it is the invariant that was
 * actually violated.
 */

const fs = require('fs');
const path = require('path');
const { ok, eq, run } = require('./lib/check.js');
const { root, requireTree } = require('./lib/roots.js');

const ROOT = requireTree(root(process.argv), 'extension tree');
const POPUP = path.join(ROOT, 'modules/qr-code/popup.html');

const html = fs.readFileSync(POPUP, 'utf8');
const styleM = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
const bodyM = html.match(/<body[^>]*>([\s\S]*?)<\/body>/i);

// ── parse the stylesheet into selector -> declarations ──
const rules = [];
{
  const css = styleM ? styleM[1] : '';
  // Strip comments first: the fix's own explanation lives in one, and a
  // declaration-looking string inside a comment must not be read as a rule.
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const re = /([^{}]+)\{([^}]*)\}/g;
  let m;
  while ((m = re.exec(bare)) !== null) {
    const sels = m[1].split(',').map(s => s.trim()).filter(Boolean);
    const decls = {};
    for (const d of m[2].split(';')) {
      const i = d.indexOf(':');
      if (i < 0) continue;
      decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1).trim();
    }
    for (const s of sels) rules.push({ sel: s, decls });
  }
}

function declsFor(sel) {
  const exact = rules.filter(r => r.sel === sel);
  if (exact.length) return Object.assign({}, ...exact.map(r => r.decls));
  return null;
}

function hasAutoSideMargins(decls) {
  const ml = decls['margin-left'];
  const mr = decls['margin-right'];
  const m = decls['margin'];
  const auto = v => v !== undefined && String(v).trim() === 'auto';
  // Either the longhands, or a shorthand whose side value is auto. A shorthand
  // like `margin: 10px auto` centres; `margin: 10px` does not.
  if (auto(ml) && auto(mr)) return true;
  if (m !== undefined) {
    // CSS margin shorthand: 1 value all round; 2 is V H; 3 is T H B; 4 is T R B L.
    // Reading it as "first and last are the sides" is wrong for every case but
    // one - `margin: 10px auto` is vertical 10px with auto sides, which centres,
    // while my first version scored it as not centring and failed its own check.
    const parts = String(m).trim().split(/\s+/);
    switch (parts.length) {
      case 1: return parts[0] === 'auto';
      case 2: return parts[1] === 'auto';
      case 3: return parts[1] === 'auto';
      case 4: return parts[1] === 'auto' && parts[3] === 'auto';
      default: return false;
    }
  }
  return false;
}

// ── the direct children of <body> that the stylesheet gives a max-width ──
const directChildren = [];
{
  const body = bodyM ? bodyM[1] : '';
  // Void elements never open a scope, so they must not push depth - and
  // closing tags must pop it. Without the pop, only the first child was ever
  // seen and the scan returned an empty list, which made check 1.5 pass
  // vacuously on an empty set.
  const VOID = new Set(['area', 'base', 'br', 'col', 'embed', 'hr', 'img', 'input',
                        'link', 'meta', 'param', 'source', 'track', 'wbr']);
  const re = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m;
  let depth = 0;
  while ((m = re.exec(body)) !== null) {
    const closing = m[1] === '/';
    const tag = m[2].toLowerCase();
    if (closing) {
      if (depth > 0) depth--;
      continue;
    }
    const selfClosing = /\/>$/.test(m[0]) || VOID.has(tag);
    if (depth === 0) {
      const idM = m[3].match(/\bid\s*=\s*["']([^"']+)["']/i);
      directChildren.push({ tag, id: idM ? idM[1] : null });
    }
    if (!selfClosing) depth++;
  }
}

run('qr-popup-layout', async () => {
  ok(!!styleM, '1.1 the popup has a <style> block to check');
  ok(!!bodyM, '1.2 the popup has a <body> to check');
  eq(directChildren.length > 0, true, '1.3 and it has direct children');

  // 1.4 the body really does centre with text-align, which is the thing that
  // makes the rest of this a real trap rather than a style preference.
  const bodyDecls = declsFor('body') || {};
  eq(bodyDecls['text-align'], 'center',
    '1.4 the body centres with text-align, which does NOT centre a block box');

  // The invariant: a direct child of body, block-level, with a max-width, is
  // centred content and must carry auto side margins.
  const capped = directChildren.filter(c => {
    const d = declsFor('#' + c.id) || (c.id ? null : declsFor(c.tag));
    return d && d['max-width'] !== undefined;
  });
  ok(capped.length > 0,
    '1.5 at least one direct child of body is a max-width-capped box', JSON.stringify(capped));

  for (const c of capped) {
    const d = declsFor('#' + c.id) || declsFor(c.tag);
    ok(hasAutoSideMargins(d),
      '1.6 #' + c.id + ' is a max-width-capped block and has auto side margins',
      JSON.stringify(d));
  }

  // 1.7 the specific report: the URL under the QR code is the one that drifted.
  const urlD = declsFor('#url-display');
  ok(urlD !== null, '1.7 #url-display is styled');
  ok(urlD && urlD['max-width'] !== undefined, '1.8 and it is max-width capped');
  ok(urlD && hasAutoSideMargins(urlD),
    '1.9 so it needs auto side margins to stay centred as the popup widens');

  // 1.10 guard against the check passing for the wrong reason: if the auto
  // margins were dropped, the element must fail. Asserted by construction
  // rather than by trusting the loop above, so a future edit to the filter
  // cannot quietly turn 1.6 into a no-op.
  ok(!hasAutoSideMargins({ 'margin-top': '10px', 'max-width': '260px' }),
    '1.10 the predicate really rejects a capped block with no auto margins');
  ok(hasAutoSideMargins({ 'margin': '10px auto' }),
    '1.11 and accepts the `margin: N auto` shorthand');
  ok(!hasAutoSideMargins({ 'margin': '10px' }),
    '1.12 but rejects `margin: N`, which centres nothing');
});