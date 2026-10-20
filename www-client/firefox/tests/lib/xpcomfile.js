'use strict';
/* A fake nsIFile / nsIFileOutputStream / nsIEnvironment / nsIDirectoryService
 * that models Gecko instead of agreeing with the code under test.
 *
 * This file exists because of one specific, load-bearing decision, and the
 * reasoning is worth not losing:
 *
 * The `rozelynxWindows` experiment API used to call
 * `dir.create(Ci.nsIFile.DIRECTORY, 0o755)`. nsIFile declares no `DIRECTORY`
 * constant - only NORMAL_FILE_TYPE and DIRECTORY_TYPE - so that expression was
 * `undefined`, XPConnect coerced it to 0 for the `in unsigned long type`
 * parameter, and 0 is NORMAL_FILE_TYPE. The result was a 0-byte 0755 plain FILE
 * named after the directory, and every write under it failed afterwards. It
 * shipped, and it survived a live profile: <profile>/pwa-icons was found as a
 * 0-byte regular file, created by the very PWA launch whose own diagnostic ring
 * recorded `taskbar-icon-skip ... no-icon-file`.
 *
 * Every fake before this one modelled `create()` as "whatever the caller passed
 * is a directory", which is precisely the assumption that made the bug
 * invisible. A stand-in for the platform that agrees with the code under test
 * cannot report that the platform disagrees with it - the same lesson G.1.4
 * recorded for C++ and C.5 recorded for the menus bridge, now on the third
 * medium.
 *
 * So: a directory is created ONLY for DIRECTORY_TYPE. Anything else - 0, the
 * number for a type nobody defined, a non-number - creates a plain file, which
 * is what nsLocalFile::Create does with any type it does not recognise as
 * DIRECTORY. Children of a plain file then fail to open, exactly as they do on
 * disk. That is the whole point of the fake.
 */

const path = require('path');

/* nsIFile.idl (156.0.1) declares exactly these two create() types. */
const NORMAL_FILE_TYPE = 0;
const DIRECTORY_TYPE = 1;

class FakeNode {
  constructor(abs, isDir) {
    this._abs = abs;
    this._dir = !!isDir;
    this._leaf = path.basename(abs);
  }

  /* ---- nsIFile ---------------------------------------------------------- */

  get path() {
    return this._abs;
  }

  get nativePath() {
    return this._abs;
  }

  get leafName() {
    return this._leaf;
  }

  clone() {
    const n = new FakeNode(this._abs, this._dir);
    n._fs = this._fs;   // the filesystem has to travel with the node
    return n;
  }

  initWithPath(p) {
    if (!p) throw new Error('NS_ERROR_FILE_CORRUPTED_TYPE: initWithPath()');
    this._abs = p;
    this._leaf = path.basename(p);
    return this;
  }

  /* nsIFile exposes isRelative as a property, not a method. */
  get isRelative() {
    return !path.isAbsolute(this._abs);
  }

  get isAbsolute() {
    return path.isAbsolute(this._abs);
  }

  append(node) {
    if (node === '' || node === undefined || node === null) return;
    // nsIFile::append refuses a path separator and a leading dot-dot, which is
    // the property the sanitising callers rely on.
    if (/^[/\\]/.test(node) || node.split(/[/\\]/).includes('..')) {
      throw new Error('NS_ERROR_FILE_CORRUPTED_TYPE: append(' + node + ')');
    }
    this._abs = path.join(this._abs, node);
    this._leaf = path.basename(this._abs);
    return this;
  }

  exists() {
    return this._fs.has(this._abs);
  }

  isDirectory() {
    return this._fs.isDir(this._abs);
  }

  isFile() {
    return this._fs.isFile(this._abs);
  }

  isSymlink() {
    return false;
  }

  /* create(in unsigned long type, in unsigned long permissions,
   *       [optional, default(false)] in boolean skipAncestors)
   *
   * XPConnect coerces a JS undefined / missing argument to 0 for an unsigned
   * long, which is NORMAL_FILE_TYPE. Anything that is not DIRECTORY_TYPE
   * therefore creates a PLAIN FILE - including 0, which is exactly what
   * `Ci.nsIFile.DIRECTORY` evaluates to. */
  create(type, perms) {
    const t = coerceCreateType(type);
    if (!Number.isFinite(t)) {
      throw new Error('NS_ERROR_FAILURE: create(' + String(type) + ')');
    }
    if (this._fs.has(this._abs)) {
      throw new Error('NS_ERROR_FILE_ALREADY_EXISTS: ' + this._abs);
    }
    if (t === DIRECTORY_TYPE) {
      this._fs.mkdirAll(this._abs);
    } else {
      // Anything else is a plain file. Real nsLocalFile::Create does not
      // validate the type beyond distinguishing DIRECTORY, so neither do we.
      this._fs.mkdirAll(path.dirname(this._abs));
      this._fs.writeFile(this._abs, Buffer.alloc(0), perms || 0o644);
    }
    return this;
  }

  remove() {
    if (!this._fs.has(this._abs)) {
      throw new Error('NS_ERROR_FILE_NOT_FOUND: ' + this._abs);
    }
    if (this._fs.isDir(this._abs)) {
      this._fs.rmdirAll(this._abs);
    } else {
      this._fs.unlink(this._abs);
    }
  }

  /* nsIFile declares `attribute int64_t fileSize` (xpcom/io/nsIFile.idl), not
   * a bare `size` - reading the wrong one throws, which is itself worth
   * modelling rather than papering over. */
  get fileSize() {
    const n = this._fs.sizeOf(this._abs);
    if (n < 0) throw new Error('NS_ERROR_FILE_NOT_FOUND: ' + this._abs);
    return n;
  }
}

/* The coercion XPConnect performs on `in unsigned long type` when the argument
 * is missing or `undefined`: it arrives as 0. Exposed so a harness can assert
 * the coercion instead of assuming `Number(undefined)` means the same thing -
 * it does not; Number(undefined) is NaN, and the whole point is that the
 * parameter ends up NORMAL_FILE_TYPE. */
function coerceCreateType(type) {
  return type === undefined || type === null ? 0 : Number(type);
}

/* The filesystem behind FakeNode. Real files in a temp dir: the properties that
 * matter here - "is it a directory", "can I open a child of it", "what mode did
 * it get" - are properties of a filesystem, and a fake that answered them from
 * a JS object would be agreeing with the code again. */
class FakeFs {
  constructor(dir) {
    this.dir = dir;
  }

  abs(p) {
    return path.isAbsolute(p) ? p : path.join(this.dir, p);
  }

  has(p) {
    try {
      this.stat(p);
      return true;
    } catch (e) {
      return false;
    }
  }

  stat(p) {
    const fs = require('fs');
    return fs.lstatSync(this.abs(p));
  }

  isDir(p) {
    try {
      return this.stat(p).isDirectory();
    } catch (e) {
      return false;
    }
  }

  isFile(p) {
    try {
      return this.stat(p).isFile();
    } catch (e) {
      return false;
    }
  }

  sizeOf(p) {
    try {
      return this.stat(p).size;
    } catch (e) {
      return -1;
    }
  }

  mkdirAll(p) {
    require('fs').mkdirSync(this.abs(p), { recursive: true });
  }

  rmdirAll(p) {
    require('fs').rmSync(this.abs(p), { recursive: true, force: true });
  }
  writeFile(p, buf, perms) {
    require('fs').writeFileSync(this.abs(p), buf);
    if (perms !== undefined && perms !== null) {
      try {
        require('fs').chmodSync(this.abs(p), perms & 0o7777);
      } catch (e) {}
    }
  }

  readFile(p) {
    return require('fs').readFileSync(this.abs(p));
  }

  unlink(p) {
    require('fs').unlinkSync(this.abs(p));
  }

  /* What the caller would find on disk, for assertions that read better as
   * "the tree looks like this" than as a series of stat calls. */
  list(rel) {
    const fs = require('fs');
    const base = this.abs(rel || '');
    const out = [];
    const walk = (d, depth) => {
      let entries = [];
      try {
        entries = fs.readdirSync(d, { withFileTypes: true });
      } catch (e) {
        return;
      }
      for (const e of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        const full = path.join(d, e.name);
        const rel2 = path.relative(base, full);
        if (e.isDirectory()) {
          out.push(rel2 + '/');
          if (depth < 4) walk(full, depth + 1);
        } else {
          out.push(rel2 + ' (' + fs.statSync(full).size + 'b)');
        }
      }
    };
    walk(base, 0);
    return out;
  }
}

/* The component the API calls into, so a harness can assert what reached it. */
class FakeOutputStream {
  constructor(fs) {
    this._fs = fs;
    this._file = null;
    this._flags = 0;
    this._perms = 0;
    this._written = [];
    this._closed = false;
  }

  init(file, flags, perms) {
    if (this._file) throw new Error('NS_ERROR_ILLEGAL_VALUE: already init');
    this._file = file;
    this._flags = flags;
    this._perms = perms;
  }

  write(str, count) {
    if (!this._file) throw new Error('NS_ERROR_NOT_INITIALIZED: write');
    if (this._closed) throw new Error('NS_ERROR_ILLEGAL_VALUE: closed');
    const n = count === undefined ? str.length : count;
    this._written.push(String(str).slice(0, n));
  }

  close() {
    if (this._closed) throw new Error('NS_ERROR_ILLEGAL_VALUE: already closed');
    // The real stream opens the file lazily, on the first write, and creating
    // a child of a plain file fails here - which is how the bug presented.
    const target = this._file._abs;
    if (this._written.length) {
      const body = this._written.join('');
      if (this._fs.isDir(path.dirname(target))) {
        // The flags are honoured, because that is the whole point: the live
        // tree's bug was a wrong PR_* constant, and a fake that always
        // overwrites cannot tell a truncating open from an appending one. The
        // previous version of this file ignored the flags and wrote the file
        // whole, so it agreed with the bug it existed to catch.
        const append = (this._flags & FakeOutputStream.PR_APPEND) !== 0;
        const prev = append && this._fs.has(target)
          ? this._fs.readFile(target)
          : Buffer.alloc(0);
        this._fs.writeFile(target,
          append ? Buffer.concat([prev, Buffer.from(body, 'binary')])
                 : Buffer.from(body, 'binary'),
          this._perms);
      }
    }
    this._closed = true;
  }

  /* NSPR's PR_* values, from nsprpub/pr/include/prio.h. PR_TRUNCATE is 0x20 and
   * 0x10 is PR_APPEND - the first version of this fake had them the other way
   * round AND exposed PR_TRUNCATE as 0x10, so it not only failed to catch the
   * wrong-flag bug, it would have failed a harness that corrected the code.
   * A stand-in that pins the bug as an invariant is worse than no stand-in. */
  static get PR_RDONLY() { return 0x01; }
  static get PR_WRONLY() { return 0x02; }
  static get PR_RDWR() { return 0x04; }
  static get PR_CREATE_FILE() { return 0x08; }
  static get PR_APPEND() { return 0x10; }
  static get PR_TRUNCATE() { return 0x20; }
  static get PR_SYNC() { return 0x40; }
  static get PR_EXCL() { return 0x80; }

  get PR_WRONLY() { return FakeOutputStream.PR_WRONLY; }
  get PR_CREATE_FILE() { return FakeOutputStream.PR_CREATE_FILE; }
  get PR_APPEND() { return FakeOutputStream.PR_APPEND; }
  get PR_TRUNCATE() { return FakeOutputStream.PR_TRUNCATE; }
}

/* nsIFileInputStream, for the read-back hasDesktopEntry grew in 1.0.73.
 * init() opens the file the way PR_Open does: a missing file throws
 * NS_ERROR_FILE_NOT_FOUND (which is the reason the API's caller never sees
 * one - it stats first), and a directory refuses to open for reading,
 * because reading a directory is not a thing the entry parser wants to do
 * half of. The flags are honoured rather than ignored - the API only ever
 * passes PR_RDONLY (0x01), and a stream opened in some other mode is a
 * bug somewhere, not a read that should silently work. */
class FakeFileInputStream {
  constructor(fs) {
    this._fs = fs;
    this._file = null;
    this._buf = null;
    this._offset = 0;
  }

  init(file, ioFlags, perms, behaviorFlags) {
    if (this._file) {
      throw new Error('NS_ERROR_ALREADY_INITIALIZED: init() twice');
    }
    if (!file || !file.exists()) {
      throw new Error('NS_ERROR_FILE_NOT_FOUND: ' + (file && file.path));
    }
    if (file.isDirectory()) {
      throw new Error('NS_ERROR_FAILURE: ' + file.path + ' is a directory');
    }
    if ((ioFlags & FakeOutputStream.PR_RDONLY) !== FakeOutputStream.PR_RDONLY) {
      throw new Error('NS_ERROR_INVALID_ARG: ioFlags ' + ioFlags + ' is not PR_RDONLY');
    }
    this._file = file;
    this._buf = this._fs.readFile(file.path);
    this._offset = 0;
  }

  available() {
    if (!this._file) {
      throw new Error('NS_ERROR_NOT_INITIALIZED: available()');
    }
    if (this._closed) {
      throw new Error('NS_BASE_STREAM_CLOSED');
    }
    return Math.max(0, this._buf.length - this._offset);
  }

  read(count) {
    if (!this._file) {
      throw new Error('NS_ERROR_NOT_INITIALIZED: read()');
    }
    if (this._closed) {
      throw new Error('NS_BASE_STREAM_CLOSED');
    }
    const n = Math.min(count, this._buf.length - this._offset);
    if (n <= 0) {
      return '';
    }
    const out = this._buf.toString('binary').slice(this._offset, this._offset + n);
    this._offset += n;
    return out;
  }

  close() {
    /* Idempotent, like nsFileInputStream::Close after a null mFD. */
    this._closed = true;
  }
}

/* nsIScriptableInputStream: the string-y face the API reads through.
 * init() rejects a stream that is not what it says it is, available()
 * forwards (so a closed underlying stream surfaces as a throw, which the
 * API's read loop treats as end-of-stream), read() returns a binary string
 * where charCodeAt is the byte - which is what an Icon= parser over ASCII
 * needs - and close() closes the underlying stream too, which is what
 * nsScriptableInputStream::Close does and what the API's finally relies on
 * for exactly one close of each stream. */
class FakeScriptableInputStream {
  constructor() {
    this._stream = null;
  }

  init(stream) {
    if (this._stream) {
      throw new Error('NS_ERROR_ALREADY_INITIALIZED: init() twice');
    }
    if (!stream || typeof stream.available !== 'function' ||
        typeof stream.read !== 'function') {
      throw new Error('NS_ERROR_INVALID_ARG: init(not a stream)');
    }
    this._stream = stream;
  }

  available() {
    if (!this._stream) {
      throw new Error('NS_ERROR_NOT_INITIALIZED: available()');
    }
    return this._stream.available();
  }

  read(count) {
    if (!this._stream) {
      throw new Error('NS_ERROR_NOT_INITIALIZED: read()');
    }
    return this._stream.read(count);
  }

  close() {
    if (this._stream) {
      this._stream.close();
      this._stream = null;
    }
  }
}

/* A chrome browser window, modelled on what Gecko actually hands out.
 *
 * Two properties are load-bearing and both were got wrong in the real code:
 *
 *  - A WebExtension window id is `window.docShell.outerWindowID`, NOT
 *    `window.windowID`. That is `WindowTrackerBase._windowIds` in 156.0.1
 *    (toolkit/components/extensions/parent/ext-tabs-base.js:1722), and
 *    `WindowTrackerBase.getWindow` resolves the id with
 *    `Services.wm.getOuterWindowWithId` (line 1855). A fake that only grew a
 *    `windowID` property would let `w.windowID === windowId` keep "working" -
 *    and in the browser that comparison is dead code, because `windowID` is the
 *    legacy DOM string and never equals the numeric id.
 *
 *  - `outerWindowID` is not guaranteed to arrive as a JS number, so the
 *    comparison has to be done on strings. The fake can produce it as a number
 *    or as a string, and the harness runs both.
 *
 * `qiThrows` models the one thing that was observed failing in the real
 * browser: QueryInterface() called FROM THE SANDBOX refusing mozIDOMWindowProxy.
 * The privileged glue conversion (`glueAccepts`) is a separate switch, because
 * it is a different code path and it is allowed to behave differently - that
 * difference is the whole reason the fix does not depend on the QI.
 *
 * `qiThrowsRaw` throws a bare string instead of an Error. XPConnect is entitled
 * to throw whatever it likes and a JS `catch` cannot assume an Error, so the
 * reason-reporting has to survive a non-Error throw rather than producing
 * "undefined" or a crash - which is the case that would make the log useless
 * exactly when it matters.
 */
class FakeChromeWindow {
  constructor(id, opts) {
    const o = opts || {};
    this.outerWindowID = o.idAsString ? String(id) : id;
    this.gBrowser = o.noTabbrowser ? null : { tabs: [], selectedBrowser: null };
    // The legacy DOM property: a string, and NOT the WebExtension window id.
    this.windowID = 'nsWindowID:' + id;
    this.docShell = { outerWindowID: this.outerWindowID };
    this.closed = false;
    this._qiThrows = !!o.qiThrows;
    this._qiThrowsRaw = o.qiThrowsRaw === undefined ? null : o.qiThrowsRaw;
    this._glueAccepts = o.glueAccepts !== false;
    this.document = { documentElement: { attrs: {}, setAttribute(k, v) { this.attrs[k] = v; }, removeAttribute(k) { delete this.attrs[k]; }, getAttribute(k) { return this.attrs[k]; } } };
  }
  focus() { this.focused = true; }
  QueryInterface(iface) {
    if (this._qiThrowsRaw !== null) {
      throw this._qiThrowsRaw;
    }
    if (this._qiThrows) {
      throw new Error('NS_ERROR_NO_INTERFACE (from sandbox)');
    }
    if (!iface) {
      throw new Error('NS_ERROR_NO_INTERFACE (no interface)');
    }
    return this;
  }
}

/* Stand in for @bytewheel.org/pwa/linux-taskbar;1. Records what reached it, so
 * a check can assert the component was actually called - and with what. */
class FakeTaskbar {
  constructor(opts) {
    this.calls = [];
    this._glueAccepts = !opts || opts.glueAccepts !== false;
    this._fails = (opts && opts.fail) || null;
  }
  setWindowClass(win, klass, title) {
    if (this._fails) throw new Error(this._fails);
    this.calls.push({ method: 'setWindowClass', klass, title, viaQi: win && win._qiOk === true });
  }
  setWindowIconFromPath(win, path) {
    if (this._fails) throw new Error(this._fails);
    this.calls.push({ method: 'setWindowIconFromPath', path });
  }
}

/* Build the sandbox the experiment API runs in: the two globals it declares it
 * may use (Services, Ci), plus the XPCOM factory it reaches through Cc.
 *
 * `ci.nsIFile` deliberately exposes ONLY the two constants the real nsIFile
 * declares. Adding a `DIRECTORY` alias here would make the fake agree with the
 * bug and defeat the point of the harness. */
function makeSandbox(opts) {
  const o = opts || {};
  const fsys = new FakeFs(o.tmpDir);
  const home = o.home || path.join(fsys.dir, 'home');
  const profd = o.profd || path.join(fsys.dir, 'profile');
  fsys.mkdirAll(home);
  fsys.mkdirAll(profd);

  const env = {
    get: (name) => {
      if (Object.prototype.hasOwnProperty.call(o.env || {}, name)) {
        return o.env[name];
      }
      return '';
    },
  };

  const Ci = {
    nsIFile: {
      NORMAL_FILE_TYPE,
      DIRECTORY_TYPE,
      DIRECTORY: undefined, // what the bare form evaluates to in the real thing
      CREATECREATE: undefined,
    },
    nsIFileInputStream: { name: 'nsIFileInputStream' },
    nsIScriptableInputStream: { name: 'nsIScriptableInputStream' },
    mozIDOMWindowProxy: { name: 'mozIDOMWindowProxy' },
  };

  // The window set the fake browser has open, keyed by outerWindowID.
  const windows = (o.windows || []).map(w =>
    (w instanceof FakeChromeWindow ? w : new FakeChromeWindow(w.id, w)));

  const Services = {
    dirsvc: {
      get(which) {
        if (which === 'Home') return homeNode();
        if (which === 'ProfD') return profdNode();
        throw new Error('NS_ERROR_FAILURE: no nsIFile for ' + which);
      },
    },
    env,
    wm: {
      // The call WindowTrackerBase.getWindow makes (ext-tabs-base.js:1855).
      getOuterWindowWithId(id) {
        if (id === undefined || id === null) return null;
        return windows.find(w => String(w.outerWindowID) === String(id)) || null;
      },
      getEnumerator(kind) {
        if (kind !== 'navigator:browser') {
          return { hasMoreElements: () => false, getNext: () => null };
        }
        let i = 0;
        return {
          hasMoreElements: () => i < windows.length,
          getNext: () => windows[i++],
        };
      },
    },
  };

  const homeNode = () => {
    const n = new FakeNode(home, true);
    n._fs = fsys;
    return n;
  };
  const profdNode = () => {
    const n = new FakeNode(profd, true);
    n._fs = fsys;
    return n;
  };

  const Cc = {
    '@mozilla.org/file/local;1': {
      createInstance(iface) {
        if (iface === Ci.nsIFile || iface === 'nsIFile') {
          const n = new FakeNode('/', true);
          n._fs = fsys;
          return n;
        }
        throw new Error('unsupported interface ' + String(iface));
      },
    },
    '@mozilla.org/network/file-output-stream;1': {
      createInstance() {
        return new FakeOutputStream(fsys);
      },
    },
    '@mozilla.org/network/file-input-stream;1': {
      createInstance() {
        return new FakeFileInputStream(fsys);
      },
    },
    '@mozilla.org/scriptableinputstream;1': {
      createInstance() {
        return new FakeScriptableInputStream();
      },
    },
  };

  return { Services, Ci, Cc, fsys, home, profd, windows };
}

/* Attach the filesystem to every node the API can reach. FakeNode keeps it on
 * the instance, so nodes created by clone()/append() inherit it - append()
 * returns the same object, and clone() copies _fs, so this only has to cover
 * the roots. */
function bind(sandbox, nodes) {
  (nodes || []).forEach(n => { if (n) n._fs = sandbox.fsys; });
}

/* Evaluate lib/experiments/windows-api.js verbatim in a vm with this sandbox,
 * and hand back its rozelynxWindows object. Nothing is reimplemented: the file
 * under test is the one that ships. */
function loadApi(rootDir, sandbox) {
  const fs = require('fs');
  const vm = require('vm');
  const src = fs.readFileSync(
    path.join(rootDir, 'lib/experiments/windows-api.js'), 'utf8');
  class ExtensionAPI {}
  const ctx = vm.createContext(Object.assign({
    ExtensionAPI,
    console,
    ChromeUtils: { generateQI: () => ({}) },
  }, sandbox));
  ctx.globalThis = ctx;
  vm.runInContext(src, ctx, { filename: 'windows-api.js' });
  // getAPI() returns { <namespace>: {...} }, which is what the schema's
  // single namespace maps onto.
  const api = ctx.rozelynxWindows.prototype.getAPI({ extension: { windowManager: null } });
  return api.rozelynxWindows;
}

module.exports = {
  NORMAL_FILE_TYPE,
  DIRECTORY_TYPE,
  coerceCreateType,
  FakeNode,
  FakeFs,
  FakeOutputStream,
  FakeFileInputStream,
  FakeScriptableInputStream,
  FakeChromeWindow,
  FakeTaskbar,
  makeSandbox,
  bind,
  loadApi,
};
