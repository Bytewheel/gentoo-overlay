/* The native messaging host's generic hand-off verbs.
 *
 * D.7. The real files/rozelynx/host/rozelynx-host is IMPORTED as a module -
 * never reimplemented - and its new `handoff` / `handoff-probe` verbs are
 * driven directly, against real programs on PATH and against its own FAKE
 * mode. The uGet verbs are re-run at the end so a change to the generic half
 * cannot quietly break the builtin.
 *
 * The import strips the `if __name__ == '__main__'` guard so importing does not
 * start the stdio loop, and nothing else in the file is touched.
 *
 * Run:  node tests/downloads-handoff-host.js [<path to rozelynx-host>]
 */

const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { ok, eq, run } = require('./lib/check');
const { hostPath, requireTree } = require('./lib/roots');

const HOST = hostPath(process.argv);
if (!fs.existsSync(HOST)) {
  console.error('FATAL: no rozelynx-host at ' + HOST);
  process.exit(2);
}

// import the host as a module without running main()
const src = fs.readFileSync(HOST, 'utf8');
const mod = { exports: {} };
const py = `
import importlib.util, sys, json
spec = importlib.util.spec_from_loader('rzhost', loader=None)
m = importlib.util.module_from_spec(spec)
m.__file__ = ${JSON.stringify(HOST)}
code = open(${JSON.stringify(HOST)}).read()
# strip the __main__ guard so importing does not start the stdio loop
code = code.replace("if __name__ == '__main__':\\n    main()", "pass")
exec(compile(code, ${JSON.stringify(HOST)}, 'exec'), m.__dict__)
print(json.dumps({'OK': True}))
`;
execFileSync('python3', ['-c', py], { stdio: ['ignore', 'pipe', 'pipe'] });

/* The handed-off program writes its argv a moment after it starts, so a check
 * that reads it has to wait for the write rather than assume it has landed. */
function waitFor(file, tries) {
  const n = tries || 40;
  for (let i = 0; i < n; i++) {
    if (fs.existsSync(file)) return true;
    execFileSync('sleep', ['0.1']);
  }
  return fs.existsSync(file);
}

function call(fn, msg) {
  const py2 = `
import importlib.util, json
m = importlib.util.module_from_spec(importlib.util.spec_from_loader('rz', loader=None))
m.__file__ = ${JSON.stringify(HOST)}
code = open(${JSON.stringify(HOST)}).read()
code = code.replace("if __name__ == '__main__':\\n    main()", "pass")
exec(compile(code, ${JSON.stringify(HOST)}, 'exec'), m.__dict__)
fn = getattr(m, ${JSON.stringify(fn)})
print(json.dumps(fn(${JSON.stringify(msg === undefined ? {} : msg)})))
`;
  const out = execFileSync('python3', ['-c', py2], { env: Object.assign({}, process.env), encoding: 'utf8' });
  return JSON.parse(out);
}

function callFake(fn, msg) {
  const py3 = `
import importlib.util, json, os
os.environ['BROWSER_FAKE'] = '1'
m = importlib.util.module_from_spec(importlib.util.spec_from_loader('rz', loader=None))
m.__file__ = ${JSON.stringify(HOST)}
code = open(${JSON.stringify(HOST)}).read()
code = code.replace("if __name__ == '__main__':\\n    main()", "pass")
exec(compile(code, ${JSON.stringify(HOST)}, 'exec'), m.__dict__)
print(json.dumps(getattr(m, ${JSON.stringify(fn)})(${JSON.stringify(msg)})))
`;
  return JSON.parse(execFileSync('python3', ['-c', py3],
    { env: Object.assign({}, process.env, { PATH: SCRATCH + ':' + process.env.PATH }), encoding: 'utf8' }));
}

// A real program to hand off to, so this is not all fakes.
// Scratch space for the real program this harness hands off to. Under the OS
// temp dir rather than a fixed path, so two runs cannot collide.
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'rz-handoff-'));
const REAL = path.join(SCRATCH, 'handoff-target.sh');
const ARGV_FILE = path.join(SCRATCH, 'argv.txt');
const CJ_FILE = path.join(SCRATCH, 'cookies.txt');
fs.writeFileSync(REAL, '#!/bin/sh\nprintf "%s\\n" "$@" > ' + ARGV_FILE + '\nsleep 5\n');
fs.chmodSync(REAL, 0o755);
// A bare name on PATH, so the host's shutil.which() is genuinely exercised.
try { execFileSync('ln', ['-sf', REAL, path.join(SCRATCH, 'handoff-target')]); } catch (e) {}

// ── _resolve_program / do_handoff_probe ────────────────────────────
{
  const r = call('do_handoff_probe', { program: 'sh' });
  ok(r.ok === true, '1.1 a bare name on PATH resolves', JSON.stringify(r));
  ok(typeof r.path === 'string' && r.path.length > 0, '1.2 and reports the absolute path');
  eq(r.program, 'sh', '1.3 echoes the program name');
}
for (const [name, why] of [
  ['nope-not-installed-xyz', 'absent from PATH'],
  ['', 'empty'],
  ['/bin/sh', 'an absolute path'],
  ['./sh', 'a relative path'],
  ['sh -c x', 'a name with a space and args'],
  ['../bin/sh', 'a traversal'],
  ['a/b', 'a subdirectory'],
  [';id', 'a shell metacharacter'],
  ['$(id)', 'a command substitution'],
]) {
  const r = call('do_handoff_probe', { program: name });
  ok(r.ok === false, '1.4 refused: ' + why, JSON.stringify(r));
  ok(typeof r.error === 'string' && r.error.length > 0, '1.5 with a reason: ' + why);
}
{
  const r = call('do_handoff_probe', {});
  ok(r.ok === false, '1.6 no program at all is refused');
}
{
  // the probe must not run anything
  fs.rmSync(ARGV_FILE, { force: true });
  call('do_handoff_probe', { program: 'handoff-target' });
  ok(!fs.existsSync(ARGV_FILE), '1.7 the probe runs nothing');
}

// ── _substitute ────────────────────────────────────────────────────
function sub(template, values) {
  const pyS = `
import importlib.util, json
m = importlib.util.module_from_spec(importlib.util.spec_from_loader('rz', loader=None))
m.__file__ = ${JSON.stringify(HOST)}
code = open(${JSON.stringify(HOST)}).read()
code = code.replace("if __name__ == '__main__':\\n    main()", "pass")
exec(compile(code, ${JSON.stringify(HOST)}, 'exec'), m.__dict__)
argv, err = m._substitute(${template === null ? 'None' : JSON.stringify(template)}, ${JSON.stringify(values || {})})
print(json.dumps({'argv': argv, 'err': err}))
`;
  return JSON.parse(execFileSync('python3', ['-c', pyS], { encoding: 'utf8' }));
}
{
  eq(sub('{url}', { url: 'https://e.com/a' }).argv, ['https://e.com/a'], '2.1 {url}');
  eq(sub('-x 4 -d . {url}', { url: 'U' }).argv, ['-x', '4', '-d', '.', 'U'], '2.2 several args');
  eq(sub('{url} {filename}', { url: 'U', filename: 'a b.iso' }).argv, ['U', 'a b.iso'],
    '2.3 a filename with a space stays ONE argument (shlex, not .split)');
  eq(sub('prog {url}', {}).argv, ['prog'], '2.4 a placeholder that expands to nothing is dropped, not passed as \'\'');
  eq(sub('{url} {filename}', { url: 'U' }).argv, ['U'], '2.4b dropping happens per token, so the others survive');
  eq(sub('{unknown}', { url: 'U' }).err !== null, true, '2.5 an unknown placeholder is an error');
  eq(sub('', {}).err !== null, true, '2.6 an empty template is an error');
  eq(sub('   ', {}).err !== null, true, '2.7 whitespace-only is an error');
  eq(sub('"unclosed', {}).err !== null, true, '2.8 unbalanced quotes are an error');
  eq(sub(Array.from({ length: 200 }, (_, i) => 'a' + i).join(' ') + ' {url}', { url: 'U' }).err !== null,
    true, '2.9 too many arguments is an error');
  eq(sub('{url}'.repeat(2000), { url: 'U' }).err !== null, true, '2.10 an over-long template is an error');
  eq(sub(null, {}).err !== null, true, '2.11 a non-string template is an error');
  // shell metacharacters survive as literal argv entries - no shell involved
  const inj = sub('{url}', { url: 'https://e.com/a;rm -rf /' }).argv;
  eq(inj, ['https://e.com/a;rm -rf /'], '2.12 shell metacharacters are one literal argument');
}

// ── do_handoff, fake mode ──────────────────────────────────────────
{
  const r = callFake('do_handoff', { program: 'handoff-target', args: '-x 4 {url}', url: 'https://e.com/f.iso', filename: 'f.iso' });
  ok(r.ok === true, '3.1 fake hand-off succeeds', JSON.stringify(r));
  eq(r.argv, [path.join(SCRATCH, 'handoff-target'), '-x', '4', 'https://e.com/f.iso'],
    '3.2 with the substituted argv');
  eq(r.program, 'handoff-target', '3.3 reporting the program');
  ok(r.fake === true, '3.4 marked as a fake run');
}
{
  const r = callFake('do_handoff', { program: '/bin/sh', args: '{url}', url: 'https://e.com/x' });
  ok(r.ok === false, '3.5 fake mode still refuses an absolute path');
}
{
  const r = callFake('do_handoff', { program: 'handoff-target', args: '{url}' });
  ok(r.ok === false && /no url/.test(r.error), '3.6 no url is refused');
}
{
  const r = callFake('do_handoff', { program: 'handoff-target', args: '{url}', url: 'file:///etc/passwd' });
  ok(r.ok === false && /http/.test(r.error), '3.7 a non-http(s) url is refused');
}
{
  const r = callFake('do_handoff', { program: 'nope-not-installed-xyz', args: '{url}', url: 'https://e.com/x' });
  ok(r.ok === false && /not found on PATH/.test(r.error), '3.8 a missing program is refused');
}

// ── do_handoff, for real ───────────────────────────────────────────
// PATH is set explicitly so the symlink above is found.
function callReal(fn, msg) {
  const pyR = `
import importlib.util, json
m = importlib.util.module_from_spec(importlib.util.spec_from_loader('rz', loader=None))
m.__file__ = ${JSON.stringify(HOST)}
code = open(${JSON.stringify(HOST)}).read()
code = code.replace("if __name__ == '__main__':\\n    main()", "pass")
exec(compile(code, ${JSON.stringify(HOST)}, 'exec'), m.__dict__)
print(json.dumps(getattr(m, ${JSON.stringify(fn)})(${JSON.stringify(msg)})))
`;
  return JSON.parse(execFileSync('python3', ['-c', pyR],
    { env: Object.assign({}, process.env, { PATH: SCRATCH + ':' + process.env.PATH }), encoding: 'utf8' }));
}
{
  fs.rmSync(ARGV_FILE, { force: true });
  const t0 = Date.now();
  const r = callReal('do_handoff', { program: 'handoff-target', args: '{filename} {url}', url: 'https://e.com/real.iso', filename: 'real.iso' });
  const dt = Date.now() - t0;
  ok(r.ok === true, '4.1 a real hand-off succeeds', JSON.stringify(r));
  ok(typeof r.pid === 'number' && r.pid > 0, '4.2 and reports a real pid');
  ok(dt < 2000, '4.3 it returns immediately, not after the program exits', dt + 'ms');
  // give the detached child a moment to write its argv
  waitFor(ARGV_FILE);
  ok(fs.existsSync(ARGV_FILE), '4.4 the program really ran');
  const got = fs.readFileSync(ARGV_FILE, 'utf8').trim().split('\n');
  eq(got, ['real.iso', 'https://e.com/real.iso'], '4.5 and saw exactly the substituted argv');
  try { process.kill(r.pid); } catch (e) {}
}
{
  // Cookies travel as TEXT in the message and {cookies} becomes a PATH the
  // program can open: aria2/wget/curl all want a file, and only the host
  // should be deciding where a file of live cookies lives.
  const cookieText = '# Netscape HTTP Cookie File\n.example.com\tTRUE\t/\tFALSE\t0\tsid\tabc123\n';
  fs.rmSync(ARGV_FILE, { force: true });
  const r = callReal('do_handoff', {
    program: 'handoff-target', args: '--load-cookies={cookies} {url}',
    url: 'https://e.com/c', cookies: cookieText,
  });
  ok(r.ok === true, '4.6 a {cookies} template is accepted', JSON.stringify(r));
  ok(typeof r.cookieFile === 'string' && r.cookieFile.length > 0, '4.7 a cookie file path comes back');
  ok(/\/rozelynx\/handoff\/cookies-/.test(r.cookieFile), '4.8 it is in the session runtime dir, not a persistent cache', r.cookieFile);
  ok(r.cookieFile.indexOf('/.cache/') < 0, '4.8b and specifically not under ~/.cache');
  {
    const st = fs.statSync(r.cookieFile);
    eq((st.mode & 0o777).toString(8), '600', '4.9 the cookie file is 0600');
    const body = fs.readFileSync(r.cookieFile, 'utf8');
    ok(body.indexOf('sid\tabc123') >= 0, '4.10 it holds the Netscape text verbatim');
    ok(body.endsWith('\n'), '4.11 with a trailing newline');
  }
  waitFor(ARGV_FILE);
  const got = fs.readFileSync(ARGV_FILE, 'utf8').trim().split('\n');
  eq(got, ['--load-cookies=' + r.cookieFile, 'https://e.com/c'], '4.12 the program got the path, not the text');
  // The host exits right after replying, so the reaper thread cannot be what
  // cleans this up - that is why the file lives in the session runtime dir.
  // What IS asserted is that the directory is the volatile one, i.e. that a
  // logout is what bounds its life.
  const dir = path.dirname(r.cookieFile);
  const runtime = process.env.XDG_RUNTIME_DIR;
  ok(runtime ? dir.indexOf(runtime) === 0 : dir.indexOf('/tmp/rozelynx-') === 0,
    '4.13 the cookie file lives where the session clears it', dir);
  try { process.kill(r.pid); } catch (e) {}
}
{
  // an empty cookie body writes nothing, and the token holding it is dropped
  const r = callFake('do_handoff', { program: 'handoff-target', args: '-b {cookies} {url}', url: 'https://e.com/n' });
  eq(r.cookieFile, '', '4.14 no cookies means no file');
  eq(r.argv, [path.join(SCRATCH, 'handoff-target'), '-b', 'https://e.com/n'],
    '4.15 and the {cookies} token is dropped rather than passed as \'\'');
}
{
  // a sweep removes what a crash left behind, but not what is in use
  const dir = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'rozelynx', 'handoff');
  const stale = path.join(dir, 'cookies-1-1.txt');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(stale, 'old');
  const old = Date.now() / 1000 - 90000;
  fs.utimesSync(stale, old, old);
  const fresh = path.join(dir, 'cookies-2-2.txt');
  fs.writeFileSync(fresh, 'new');
  callFake('do_handoff', { program: 'handoff-target', args: '{url}', url: 'https://e.com/s' });
  ok(!fs.existsSync(stale), '4.16 the sweep removed the stale cookie file');
  ok(fs.existsSync(fresh), '4.17 and left a recent one alone');
  fs.rmSync(fresh, { force: true });
}
{
  // a template error must not leave a cookie file behind
  const cdir = path.join(process.env.XDG_RUNTIME_DIR || '/tmp', 'rozelynx', 'handoff');
  const before = fs.existsSync(cdir) ? fs.readdirSync(cdir).sort() : [];
  const r = callFake('do_handoff', { program: 'handoff-target', args: '{nope} {url}', url: 'https://e.com/x', cookies: 'a=b' });
  ok(r.ok === false && /placeholder/.test(r.error), '4.18 a bad template is refused', JSON.stringify(r));
  const after = fs.existsSync(cdir) ? fs.readdirSync(cdir).sort() : [];
  eq(after, before, '4.19 and no cookie file was left on disk by the refusal');
}

// ── the uGet verbs still work (nothing regressed) ──────────────────
{
  const r = call('do_uget_probe', {});
  ok(r.ok === true, '5.1 the real uget-integrator still answers the probe', JSON.stringify(r));
  ok(r.uget && r.uget.length > 0, '5.2 and reports a uGet version', r.uget);
  ok(r.integrator === 'uget-integrator', '5.3 naming the integrator');
}
{
  const r = call('do_uget', {});
  ok(r.ok === false && r.error === 'no url', '5.4 do_uget still refuses an empty url');
  const r2 = call('do_uget', { url: 'file:///x' });
  ok(r2.ok === false && /http/.test(r2.error), '5.5 and a non-http url');
}

// ── the dispatch table knows the new verbs ─────────────────────────
{
  ok(src.includes("elif action == 'handoff-probe':"), '6.1 handoff-probe is dispatched');
  ok(src.includes("elif action == 'handoff':"), '6.2 handoff is dispatched');
  ok(/elif action == 'handoff':/.test(src) && src.indexOf("elif action == 'uget':") < src.indexOf("elif action == 'handoff-probe':"),
    '6.3 the uGet verbs are matched first (their names are not prefixes of the new ones)');
}
{
  // the header comment must document both new verbs
  ok(/#\s+-> \{"action": "handoff-probe"/.test(src), '6.4 the header documents handoff-probe');
  ok(/#\s+-> \{"action": "handoff"/.test(src), '6.5 the header documents handoff');
  ok(/TRUST BOUNDARY/.test(src), '6.6 the header states the trust boundary');
}

// This harness is deliberately top-level: each section spawns real processes at
// module scope, so there is no async main to hand to run(). The empty one is
// only here to print the summary and set the exit code - and if a section
// throws, the exit handler in lib/check.js reports ABORTED rather than a pass.
run('downloads-handoff-host', () => {});
