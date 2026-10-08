#!/usr/bin/env node
'use strict';
/* Harness for the `rozelynxSecurity` experiment API and its wiring into
 * the PWA security menu.
 *
 * The API is two functions around one permission, so the failure modes
 * that matter are all granularity failures: granting broader than asked,
 * reading a grant inherited from a parent domain, or touching a
 * permission type other than "canvas". The fake Services below answers
 * only what the API should call - testPermissionFromPrincipal simply does
 * not exist on it, so inheriting reads fail loudly instead of silently -
 * and the checks record what actually landed.
 *
 * Sections:
 *   1  grant: the "canvas" permission, ALLOW, exactly the asked origin
 *   2  the grant is per-origin: another origin reads nothing
 *   3  revoke: removal by the same principal + type, and the read follows
 *   4  a bad origin is a named {ok:false}, never a throw
 *   5  the schema and the implementation agree
 *   6  the manifest registers the experiment
 *   7  the pwa background routes the menu actions behind the PWA gate
 *   8  the synthetic menu renders the entry only in PWA windows
 */

const fs = require('fs');
const path = require('path');
const vm = require('vm');

const { ok, eq, run } = require('./lib/check.js');
const { root, requireTree } = require('./lib/roots.js');

const EXT = requireTree(root(process.argv), 'extension tree');

// ── fakes ────────────────────────────────────────────────────────────

// A principal whose whole identity is its origin: what
// createContentPrincipal produces for an origin string, as far as the
// permission manager is concerned.
function fakePrincipal(origin) {
  return { origin: origin };
}

function fakePerms() {
  const grants = new Map(); // origin -> { type, action }
  const calls = [];
  return {
    ALLOW_ACTION: 1,
    DENY_ACTION: 2,
    PROMPT_ACTION: 3,
    addFromPrincipal(principal, type, action) {
      calls.push(['add', principal.origin, type, action]);
      grants.set(principal.origin, { type: type, action: action });
    },
    removeFromPrincipal(principal, type) {
      calls.push(['remove', principal.origin, type]);
      // The real thing only drops the recorded type; the fake matches.
      const g = grants.get(principal.origin);
      if (g && g.type === type) {
        grants.delete(principal.origin);
      }
    },
    testExactPermissionFromPrincipal(principal, type) {
      calls.push(['testExact', principal.origin, type]);
      const g = grants.get(principal.origin);
      if (g && g.type === type) {
        return g.action;
      }
      return 0; // UNKNOWN_ACTION: nothing recorded for this exact origin
    },
    grants,
    calls,
  };
}

function fakeServices() {
  return {
    io: {
      newURI(spec) {
        if (!/^https?:\/\/[a-z0-9.-]+(:\d+)?$/i.test(spec)) {
          throw new Error('NS_ERROR_MALFORMED_URI: ' + spec);
        }
        return { spec: spec };
      },
    },
    scriptSecurityManager: {
      createContentPrincipal(uri) {
        return fakePrincipal(uri.spec);
      },
    },
    perms: fakePerms(),
  };
}

function loadSecurityApi(Services) {
  const src = fs.readFileSync(
    path.join(EXT, 'lib/experiments/security-api.js'), 'utf8');
  class ExtensionAPI {}
  const ctx = vm.createContext({ ExtensionAPI, Services, console });
  ctx.globalThis = ctx;
  vm.runInContext(src, ctx, { filename: 'security-api.js' });
  return ctx.rozelynxSecurity.prototype.getAPI({ extension: {} }).rozelynxSecurity;
}

const APP = 'https://app.example.com';
const OTHER = 'https://other.example.com';

run('security-canvas', async () => {
  // ── 1. grant ───────────────────────────────────────────────────────
  let sb = fakeServices();
  let api = loadSecurityApi(sb);

  let res = await api.setCanvasData(APP, true);
  eq(res.ok, true, '1.1 grant answers ok');
  eq(res.enabled, true, '1.2 ...and reports the new state');
  eq(sb.perms.grants.get(APP).type, 'canvas',
    '1.3 the recorded permission type is "canvas"');
  eq(sb.perms.grants.get(APP).action, sb.perms.ALLOW_ACTION,
    '1.4 ...with ALLOW, the action the RFP canvas check looks for');

  // ── 2. per-origin ───────────────────────────────────────────────────
  let other = await api.getCanvasData(OTHER);
  eq(other.ok, true, '2.1 reading an ungranted origin answers ok');
  eq(other.enabled, false, '2.2 ...and is not enabled');
  ok(!sb.perms.grants.has(OTHER),
    '2.3 the app grant never wrote anything for the other origin');
  ok(!sb.perms.calls.some(c => c[1] === OTHER && c[0] === 'add'),
    '2.4 no add call ever named the other origin');

  // ── 3. revoke ──────────────────────────────────────────────────────
  res = await api.setCanvasData(APP, false);
  eq(res.ok, true, '3.1 revoke answers ok');
  eq(res.enabled, false, '3.2 ...and reports the new state');
  const rm = sb.perms.calls.find(c => c[0] === 'remove');
  ok(rm, '3.3 a removeFromPrincipal was issued');
  if (rm) {
    eq(rm[1], APP, '3.4 ...for the same origin');
    eq(rm[2], 'canvas', '3.5 ...for the same permission type');
  }
  other = await api.getCanvasData(APP);
  eq(other.enabled, false, '3.6 the read reflects the removal');

  // ── 4. bad origin ──────────────────────────────────────────────────
  res = await api.setCanvasData('not an origin', true);
  eq(res.ok, false, '4.1 a bad origin is {ok:false}, not a throw');
  ok(!!res.error, '4.2 ...with a reason attached', res.error);
  eq(sb.perms.grants.size, 0, '4.3 nothing was recorded on the way out');

  // ── 5. schema / implementation agreement ────────────────────────────
  const schema = JSON.parse(fs.readFileSync(
    path.join(EXT, 'lib/experiments/security-schema.json'), 'utf8'));
  eq(schema.length, 1, '5.1 exactly one namespace');
  eq(schema[0].namespace, 'rozelynxSecurity', '5.2 named rozelynxSecurity');
  const fns = schema[0].functions;
  eq(fns.map(f => f.name).sort().join(','), 'getCanvasData,setCanvasData',
    '5.3 the schema declares exactly the two functions');
  ok(fns.every(f => f.async === true), '5.4 every schema function is async');
  sb = fakeServices();
  api = loadSecurityApi(sb);
  eq(typeof api.setCanvasData, 'function', '5.5 the implementation has setCanvasData');
  eq(typeof api.getCanvasData, 'function', '5.6 ...and getCanvasData');
  const setDecl = fns.find(f => f.name === 'setCanvasData');
  eq(setDecl.parameters.length, 2, '5.7 setCanvasData takes two parameters');
  eq(setDecl.parameters.map(p => p.type).join(','),
    'string,boolean', '5.8 ...a string origin and a boolean enable');

  // ── 6. manifest registration ───────────────────────────────────────
  const manifest = JSON.parse(fs.readFileSync(
    path.join(EXT, 'manifest.json'), 'utf8'));
  const reg = manifest.experiment_apis &&
    manifest.experiment_apis.rozelynxSecurity;
  ok(reg, '6.1 the manifest registers rozelynxSecurity');
  if (reg) {
    eq(reg.schema, 'lib/experiments/security-schema.json',
      '6.2 ...pointing at the schema');
    eq(reg.parent.script, 'lib/experiments/security-api.js',
      '6.3 ...and the implementation');
    eq(reg.parent.scopes.join(','), 'addon_parent',
      '6.4 parent-only: content scripts cannot reach it');
    eq(reg.parent.paths[0].join(','), 'rozelynxSecurity',
      '6.5 exposed as browser.rozelynxSecurity');
  }

  // ── 7. pwa background wiring ────────────────────────────────────────
  const bg = fs.readFileSync(
    path.join(EXT, 'modules/pwa/background.js'), 'utf8');
  ok(/case 'security-state':/.test(bg),
    '7.1 the router has a security-state case');
  ok(/case 'set-canvas':/.test(bg), '7.2 ...and a set-canvas case');
  ok(/browser\.rozelynxSecurity\.getCanvasData/.test(bg),
    '7.3 state is read through the experiment API');
  ok(/browser\.rozelynxSecurity\.setCanvasData/.test(bg),
    '7.4 ...and set through it');
  const stateCase = bg.slice(
    bg.indexOf("case 'security-state':"),
    bg.indexOf("case 'set-canvas':"));
  ok(/isPWAWindow/.test(stateCase),
    '7.5 the state answer is gated on the PWA-window registry');

  // ── 8. synthetic menu wiring ───────────────────────────────────────
  const mg = fs.readFileSync(
    path.join(EXT, 'modules/mouse-gestures/content.js'), 'utf8');
  ok(/module: 'pwa', action: 'security-state'/.test(mg),
    '8.1 the menu probes the pwa module for security state');
  ok(/module: 'pwa', action: 'set-canvas'/.test(mg),
    '8.2 ...and routes the toggle through it');
  ok(/probeSecurity\(\);/.test(mg),
    '8.3 the probe runs at init, next to the netiface probe');
  ok(/\{ group: 'Security settings' \}/.test(mg),
    '8.4 the entry renders under a Security settings group');
  ok(/if \(securitySettings\) \{/.test(mg),
    '8.5 ...only when the probe said this is a PWA window with the API');
  ok(/Allow HTML5 canvas data \(this app\)/.test(mg),
    '8.6 the item is the canvas data toggle');
  ok(/window\.location\.origin/.test(mg),
    '8.7 the toggle acts on the page\'s own origin, not a sender tab');
});
