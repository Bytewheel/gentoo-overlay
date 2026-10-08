#!/usr/bin/env node
'use strict';
/* Harness for the QR popup's theme contract (2026-09-30).
 *
 * Why this exists. "The hand-off dropdown is white" turned out not to be a
 * missing dark-mode rule. Every <select> in the popup did have a background and
 * a colour in both schemes - and the one the report was about, #handoff-enabled,
 * had neither, because the three rules aimed at it were written for
 * `#handoff-master` while the element is `#handoff-master-wrap`. A selector for
 * an element that does not exist matches nothing, silently, in every scheme at
 * once. So the select fell back to the UA widget over the dark body colour:
 * light text on a white widget. Nothing about the module's logic was wrong, and
 * exercising the module cannot see it.
 *
 * That makes the general rule the one worth asserting, and it is two rules:
 *
 *   1. every id selector in the stylesheet resolves to a real element, in the
 *      markup or in the editor scripts that build rows at runtime;
 *   2. every <select> is given a background AND a text colour in BOTH schemes,
 *      and the page declares `color-scheme`.
 *
 * The second exists because of what a <select> is: the closed widget is styled
 * by the page, but the list that drops down on click is drawn by the UA from
 * `color-scheme`. With that undeclared, a select can be perfectly styled in
 * both schemes and still open a white list on a dark system - which is how
 * this was first misdiagnosed as a missing CSS rule.
 */

const fs = require('fs');
const path = require('path');
const { ok, eq, run } = require('./lib/check.js');
const { root, requireTree } = require('./lib/roots.js');

const ROOT = requireTree(root(process.argv), 'extension tree');
const POPUP = path.join(ROOT, 'modules/qr-code/popup.html');
const NETIFACE_UI = path.join(ROOT, 'modules/netiface/urlrules-ui.js');
const HANDLERS_UI = path.join(ROOT, 'modules/downloads-handoff/handlers-ui.js');

const html = fs.readFileSync(POPUP, 'utf8');
const styleM = html.match(/<style[^>]*>([\s\S]*?)<\/style>/i);
const css = (styleM ? styleM[1] : '').replace(/\/\*[\s\S]*?\*\//g, '');
const body = html.slice(html.indexOf('<body'));

// ── brace-matched @media extraction ──
// A regex like /@media[^{]+\{([^}]*)\}/ cannot reach a media block's inner
// rules, because they contain braces of their own: it stops at the first
// nested '}' and silently reports a truncated block, which then looks like the
// selector is missing from dark mode. Walk the braces instead.
function mediaBlocks(text, condition) {
  const out = [];
  const re = new RegExp('@media\\s*\\(' + condition + '\\)\\s*\\{', 'g');
  let m;
  while ((m = re.exec(text)) !== null) {
    let depth = 1, i = m.index + m[0].length;
    for (; i < text.length && depth > 0; i++) {
      if (text[i] === '{') depth++;
      else if (text[i] === '}') depth--;
    }
    out.push(text.slice(m.index + m[0].length, i - 1));
  }
  return out;
}

const DARK = mediaBlocks(css, 'prefers-color-scheme:\\s*dark').join('\n');
const LIGHT = css
  .replace(/@media[^{]+\{(?:[^{}]*\{[^{}]*\})*[^{}]*\}/g, '')
  .replace(/@media[^{]+\{[^{}]*\}/g, '');

// ── every id the stylesheet names, minus hex colours ──
// #fff and #cdd6f4 are colours, not selectors. Only tokens that cannot be a
// colour are treated as selectors, or the audit drowns in false positives.
const HEX = /^[0-9a-fA-F]{3,8}$/;
const cssIds = [...new Set(
  (css.match(/#[A-Za-z][A-Za-z0-9_-]*/g) || []).map(t => t.slice(1))
)].filter(id => !HEX.test(id));

const markupIds = new Set((body.match(/id="([^"]+)"/g) || []).map(s => s.slice(4, -1)));

// Rows are built at runtime, so their ids exist only in the editor scripts.
const runtimeIds = new Set();
for (const f of [NETIFACE_UI, HANDLERS_UI]) {
  if (!fs.existsSync(f)) continue;
  const t = fs.readFileSync(f, 'utf8');
  for (const re of [/\.id\s*=\s*'([^']+)'/g, /id:\s*'([^']+)'/g, /id="([^"]+)"/g]) {
    let m; while ((m = re.exec(t)) !== null) runtimeIds.add(m[1]);
  }
}

run('qr popup theme', () => {
  // ── 1. no id selector may address an element that does not exist ──
  const dead = cssIds.filter(id => !markupIds.has(id) && !runtimeIds.has(id));
  ok(dead.length === 0,
    'every id selector resolves to a real element',
    dead.length ? `dead: ${dead.map(d => '#' + d).join(', ')}` : `${cssIds.length} selectors checked`);

  // ── 2. color-scheme must be declared, or UA widgets ignore the theme ──
  const schemeRule = (LIGHT + DARK).match(/color-scheme\s*:\s*([^;}]+)/i);
  ok(schemeRule !== undefined,
    'color-scheme is declared',
    schemeRule ? schemeRule[1].trim() : 'not declared: the <select> popup is drawn by the UA in the default light scheme');
  // Declaring `light` alone would fix nothing for a dark system, so require
  // that the declaration actually admit both schemes.
  ok(schemeRule !== undefined && /light/i.test(schemeRule[1]) && /dark/i.test(schemeRule[1]),
    'color-scheme admits both schemes',
    schemeRule ? schemeRule[1].trim() : 'not declared');

  // ── 3. every <select> has a background and a colour, in both schemes ──
  // Real ancestors, by walking the markup with a tag stack. The first version
  // collected every div/label/section that appeared ANYWHERE before the select,
  // which gave #handoff-enabled a 22-entry chain reaching back into the URL-rules
  // section - so `.urlrules-row select` "covered" it and the check passed with
  // the very bug it exists to catch still in place. A chain that is not the
  // ancestors is worse than no chain: it manufactures false passes.
  const VOID = new Set(['area','base','br','col','embed','hr','img','input',
                        'link','meta','param','source','track','wbr']);
  const selects = [];
  {
    const stack = [];
    const tag = /<(\/)?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;
    let m;
    while ((m = tag.exec(body)) !== null) {
      const closing = m[1] === '/';
      const name = m[2].toLowerCase();
      if (closing) {
        for (let i = stack.length - 1; i >= 0; i--) {
          if (stack[i].tag === name) { stack.length = i; break; }
        }
        continue;
      }
      if (name === 'select') {
        const id = (m[3].match(/id="([^"]+)"/) || [])[1];
        const chain = [];
        for (const e of stack) {
          if (e.cls) chain.push(...e.cls.split(/\s+/).filter(Boolean).map(c => '.' + c));
          if (e.id) chain.push('#' + e.id);
        }
        selects.push({ id, chain });
        continue;
      }
      // A void element never opens a scope: pushing it would desynchronise the
      // stack for every element after it.
      if (VOID.has(name) || /\/\s*$/.test(m[3])) continue;
      const cls = (m[3].match(/class="([^"]+)"/) || [])[1];
      const id = (m[3].match(/id="([^"]+)"/) || [])[1];
      stack.push({ tag: name, cls, id });
    }
  }

  ok(selects.length > 0, 'the popup has selects to check', `${selects.length} found`);

  // Parse rules out of an already brace-matched media block. Scanning line by
  // line looks tempting and is wrong: these rules span seven or eight lines,
  // so a line that contains '{' also contains none of the declarations, and
  // every check below reports "no background" for rules that plainly have one.
  function parseRules(block) {
    const out = [];
    const re = /([^{}]+)\{([^{}]*)\}/g;
    let m;
    while ((m = re.exec(block)) !== null) {
      const decls = {};
      for (const d of m[2].split(';')) {
        const i = d.indexOf(':');
        if (i >= 0) decls[d.slice(0, i).trim().toLowerCase()] = d.slice(i + 1);
      }
      out.push({ sels: m[1].split(',').map(x => x.trim()).filter(Boolean), decls });
    }
    return out;
  }
  const lightRules = parseRules(LIGHT);
  const darkRules = parseRules(DARK);

  // A rule covers the select when it addresses the select itself or one of its
  // ancestors. Matching on `select` as a type alone is not enough - every
  // select in the popup is a select - so the ancestor token is what ties the
  // rule to this particular one.
  function paintsBackgroundAndText(rules, sel) {
    for (const r of rules) {
      for (const head of r.sels) {
        const names = head.includes('#' + sel.id) || sel.chain.some(c => head.includes(c));
        if (!names) continue;
        if (!/select/.test(head) && !head.includes('#' + sel.id)) continue;
        const hasBg = r.decls['background'] !== undefined || r.decls['background-color'] !== undefined;
        const hasFg = r.decls['color'] !== undefined;
        if (hasBg && hasFg) return true;
      }
    }
    return false;
  }

  for (const sel of selects) {
    const label = sel.id ? '#' + sel.id : '<select>';
    ok(paintsBackgroundAndText(lightRules, sel),
      `${label} has a background and text colour in the light scheme`,
      'checked ' + (sel.chain[0] || 'no ancestor'));
    ok(paintsBackgroundAndText(darkRules, sel),
      `${label} has a background and text colour in the dark scheme`,
      'checked ' + (sel.chain[0] || 'no ancestor'));
  }
});