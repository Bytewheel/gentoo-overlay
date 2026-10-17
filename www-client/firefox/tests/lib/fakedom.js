'use strict';
/* A minimal fake DOM for driving this extension's content scripts and popup
 * scripts in a vm.
 *
 * It is deliberately small: it implements what the files under test actually
 * touch and nothing else, so a harness author hits a missing method at once
 * rather than quietly testing a stub instead of the code. The two properties
 * below were both learned the hard way and are the reason this file exists
 * rather than each harness growing its own:
 *
 *   - `URL` must be the real constructor. A stub object makes `new URL(...)`
 *     throw, the content script catches it, and "not a download" comes back -
 *     a silent false negative that looks like a policy failure rather than a
 *     broken harness.
 *   - `classList` is a live view, not a copy, because the code under test adds
 *     and removes classes after the element is created.
 */

class CL {
  constructor(el) { this.el = el; this.s = new Set(); }
  add(...c) { c.forEach(x => this.s.add(x)); this.el._sync(); }
  remove(...c) { c.forEach(x => this.s.delete(x)); this.el._sync(); }
  contains(c) { return this.s.has(c); }
  toggle(c, on) { if (on === undefined) { this.s.has(c) ? this.s.delete(c) : this.s.add(c); } else if (on) { this.s.add(c); } else { this.s.delete(c); } this.el._sync(); }
  get value() { return [...this.s].join(' '); }
  set value(v) { this.s = new Set(String(v).split(/\s+/).filter(Boolean)); this.el._sync(); }
}

class El {
  constructor(tag) {
    this.tagName = String(tag).toUpperCase();
    this.nodeType = 1;
    this.children = [];
    this.parentNode = null;
    this.style = {};
    this.attributes = {};
    this._text = '';
    this._listeners = {};
    this._id = '';
    this.classList = new CL(this);
  }
  get className() { return this.classList.value; }
  set className(v) { this.classList.value = v; }
  get id() { return this._id; }
  set id(v) { this._id = String(v); this.attributes.id = String(v); }
  setAttribute(k, v) { this.attributes[k] = String(v); if (k === 'id') this._id = String(v); }
  getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attributes, k) ? this.attributes[k] : null; }
  removeAttribute(k) { delete this.attributes[k]; }
  get textContent() {
    if (this.children.length) return this.children.map(c => c.textContent).join('');
    return this._text;
  }
  // content.js closes the menu on any mousedown that does not land inside it,
  // so this is load-bearing rather than decorative - without it the dismiss
  // handler throws and the harness reports a product failure that is not one.
  contains(node) {
    for (let n = node; n; n = n.parentNode) if (n === this) return true;
    return false;
  }
  set textContent(v) { this._text = String(v); this.children.length = 0; }
  set innerHTML(v) { this._text = String(v); this.children.length = 0; }
  get innerHTML() { return this._text; }
  set title(v) { this.attributes.title = String(v); }
  get title() { return this.attributes.title || ''; }
  get href() { return this.attributes.href || ''; }
  set href(v) { this.attributes.href = String(v); }
  get src() { return this.attributes.src || ''; }
  set src(v) { this.attributes.src = String(v); }
  get currentSrc() { return this.attributes['data-current'] || this.src; }
  set currentSrc(v) { this.attributes['data-current'] = String(v); }
  get paused() { return !!this.attributes['data-paused']; }
  set paused(v) { this.attributes['data-paused'] = v ? '1' : ''; }
  get muted() { return !!this.attributes['data-muted']; }
  set muted(v) { this.attributes['data-muted'] = v ? '1' : ''; }
  get loop() { return !!this.attributes['data-loop']; }
  set loop(v) { this.attributes['data-loop'] = v ? '1' : ''; }
  get isConnected() { return this.parentNode !== null; }
  get offsetWidth() { return 240; }
  get offsetHeight() { return 20 * (this.children.length + 1); }
  appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.children.push(c); return c; }
  removeChild(c) { const i = this.children.indexOf(c); if (i >= 0) { this.children.splice(i, 1); c.parentNode = null; } return c; }
  remove() { if (this.parentNode) this.parentNode.removeChild(this); }
  _sync() {}
  addEventListener(t, fn) { (this._listeners[t] || (this._listeners[t] = [])).push(fn); }
  removeEventListener(t, fn) { const a = this._listeners[t]; if (!a) return; const i = a.indexOf(fn); if (i >= 0) a.splice(i, 1); }
  dispatch(t, ev) { const a = this._listeners[t]; if (!a) return; for (const fn of a.slice()) fn(ev); }
  // The real click() propagates - capture-phase listeners from the root down,
  // the element's own listeners, then bubble-phase back up - so a listener on
  // the document sees a click on any descendant. Element-local dispatch()
  // shows it nothing, and the release path of downloads-handoff/content.js
  // under test registers exactly there: a click() that stops at the element
  // would test no interception at all. A plain El outside a makeEnv() tree
  // has no _click installed and falls back to dispatch().
  click() {
    let root = this;
    while (root && root.parentNode) root = root.parentNode;
    if (root && root !== this && typeof root._click === 'function') { root._click(this); return; }
    this.dispatch('click', makeEvent('click', { target: this, button: 0 }));
  }
  closest(sel) {
    let n = this;
    while (n) {
      if (n._matches(sel)) return n;
      n = n.parentNode;
    }
    return null;
  }
  _matches(sel) {
    return String(sel).split(',').some(part => {
      const s = part.trim();
      if (s === '*') return true;
      // tag, then any run of .class / #id / [attr] tokens. The [attr] form
      // is what the menu-context walk under test uses ('a[href]', 'img'),
      // and a selector the fake cannot parse must not silently match.
      const m = /^([a-z0-9]+)?((?:[.#][\w-]+|\[[\w-]+\])*)$/i.exec(s);
      if (!m) return false;
      if (m[1] && this.tagName !== m[1].toUpperCase()) return false;
      if (m[2]) {
        for (const tok of m[2].match(/[.#][\w-]+|\[[\w-]+\]/g) || []) {
          if (tok[0] === '.' && !this.classList.contains(tok.slice(1))) return false;
          if (tok[0] === '#' && this._id !== tok.slice(1)) return false;
          if (tok[0] === '[' &&
              !Object.prototype.hasOwnProperty.call(this.attributes, tok.slice(1, -1))) {
            return false;
          }
        }
      }
      return true;
    });
  }
  querySelectorAll(sel) {
    const out = [];
    const parts = String(sel).split(',').map(s => s.trim()).filter(Boolean);
    const walk = n => {
      for (const c of n.children) {
        if (parts.some(p => c._matches(p))) out.push(c);
        walk(c);
      }
    };
    walk(this);
    return out;
  }
  querySelector(sel) { return this.querySelectorAll(sel)[0] || null; }
  createElement(tag) { return new El(tag); }
  getBoundingClientRect() { return { top: 0, left: 0, width: 10, height: 10, right: 10, bottom: 10 }; }
  focus() {}
  containsNode() { return false; }
  selectAllChildren() {}
}

class TextNode {
  constructor(t) { this.nodeType = 3; this._text = String(t); this.parentNode = null; }
  get textContent() { return this._text; }
}

function makeEvent(type, opts) {
  opts = opts || {};
  const e = Object.assign({
    type,
    target: null,
    isTrusted: true,
    defaultPrevented: false,
    cancelBubble: false,
    button: 2,
    clientX: 100,
    clientY: 100,
    preventDefault() { this.defaultPrevented = true; },
    stopPropagation() { this.cancelBubble = true; this._stopped = true; },
  }, opts);
  return e;
}

function makeEnv(opts) {
  opts = opts || {};
  const documentElement = new El('html');
  const body = new El('body');
  documentElement.appendChild(body);

  const doc = Object.assign(new El('#document'), {
    documentElement,
    body,
    title: 'Harness page',
    // Real documents always have a base URL; URL-with-base parsing (the save
    // paths) needs it, and a missing one silently turns "parse the URL"
    // into "no suggested filename" rather than a loud failure.
    baseURI: 'https://example.com/page',
    execCommand() { return true; },
    _listeners: {},
  });
  doc.tagName = '#DOCUMENT';

  const listeners = { doc: {}, win: {} };
  // Recordings the same way as `sent`: what downloads.download was asked
  // for, what onCreated was registered, and what location.assign navigated
  // to. All three are load-bearing for the save/release paths under test:
  // the download options are the assertion, and the Layer-B re-entry of a
  // release's own restore must be observable as "onCreated was called and
  // declined" rather than as nothing.
  const downloadCalls = [];
  const onCreated = [];
  const assigned = [];

  const location_ = {
    href: 'https://example.com/page',
    protocol: 'https:',
    assign(u) { assigned.push(String(u)); this.href = String(u); },
  };
  const window = {
    innerWidth: 1280,
    innerHeight: 900,
    location: location_,
    history: { length: 2, back() {}, forward() {} },
    print() {},
    open() { return null; },
    matchMedia(q) { return { matches: !!(opts.dark && /dark/.test(q)), media: q, addListener() {}, removeListener() {} }; },
    getSelection() { return opts.selection || { isCollapsed: true, toString: () => '', containsNode: () => false }; },
    addEventListener(t, fn, capture) { (listeners.win[t] || (listeners.win[t] = [])).push({ fn, capture: !!capture }); },
    removeEventListener(t, fn, capture) {
      const a = listeners.win[t] || []; const i = a.findIndex(x => x.fn === fn && x.capture === !!capture);
      if (i >= 0) a.splice(i, 1);
    },
    _listeners: listeners.win,
  };
  window.window = window;

  doc.addEventListener = function (t, fn, capture) { (listeners.doc[t] || (listeners.doc[t] = [])).push({ fn, capture: !!capture }); };
  // click() for a makeEnv tree: the propagation described on El. The
  // document registers through `listeners.doc`, every other El through its
  // own `_listeners`, so the walk reads both registries.
  doc._click = function (target) {
    const chain = [];
    for (let n = target; n; n = n.parentNode) chain.unshift(n);
    const ev = makeEvent('click', { target: target, button: 0 });
    const regs = (node) => (node === doc
      ? (listeners.doc['click'] || []).map(({ fn, capture }) => ({ fn, capture }))
      : ((node._listeners && node._listeners['click']) || []).map(fn => ({ fn, capture: false })));
    (listeners.win['click'] || []).forEach(({ fn, capture }) => { if (capture) fn.call(window, ev); });
    chain.slice(0, -1).forEach(node => regs(node).forEach(({ fn, capture }) => { if (capture) fn.call(node, ev); }));
    ((chain[chain.length - 1]._listeners['click']) || []).slice()
      .forEach(fn => fn.call(target, ev));
    chain.slice(0, -1).reverse().forEach(node => regs(node).forEach(({ fn, capture }) => { if (!capture) fn.call(node, ev); }));
    (listeners.win['click'] || []).forEach(({ fn, capture }) => { if (!capture) fn.call(window, ev); });
  };
  doc.createElementNS = function (ns, tag) {
    const e = new El(tag);
    e.getContext = () => ({
      clearRect() {}, beginPath() {}, moveTo() {}, lineTo() {}, stroke() {},
      set lineWidth(v) {}, set strokeStyle(v) {}, set lineCap(v) {},
    });
    return e;
  };

  // fire capture-phase document listeners, then bubble-phase window listeners
  function fire(target, type, extra) {
    const ev = makeEvent(type, Object.assign({ target }, extra));
    for (const { fn, capture } of (listeners.doc[type] || [])) {
      if (capture) fn.call(doc, ev);
    }
    for (const { fn, capture } of (listeners.win[type] || [])) {
      if (!capture) fn.call(window, ev);
    }
    return ev;
  }

  const storage = {};
  const onChanged = [];
  const sent = [];
  const logs = [];
  const replies = opts.replies || {};

  const browser = {
    runtime: {
      sendMessage(msg) {
        sent.push(msg);
        const r = replies[msg && msg.action];
        if (r === undefined) return Promise.reject(new Error('no receiver: ' + (msg && msg.action)));
        if (r && r.__reject) return Promise.reject(new Error(r.error || 'rejected'));
        return Promise.resolve(r);
      },
      getURL(p) { return 'moz-extension://harness/' + p; },
      onMessage: { addListener(fn) { this._fn = fn; } },
    },
    storage: {
      local: {
        get(keys) {
          if (Array.isArray(keys)) {
            const o = {}; for (const k of keys) if (k in storage) o[k] = storage[k];
            return Promise.resolve(o);
          }
          if (typeof keys === 'string') return Promise.resolve(keys in storage ? { [keys]: storage[keys] } : {});
          return Promise.resolve(Object.assign({}, storage));
        },
        set(obj) {
          const changes = {};
          for (const k of Object.keys(obj)) { changes[k] = { oldValue: storage[k], newValue: obj[k] }; storage[k] = obj[k]; }
          for (const fn of onChanged) fn(changes, 'local');
          return Promise.resolve();
        },
      },
      onChanged: { addListener(fn) { onChanged.push(fn); } },
    },
    // Recorded rather than a no-op: the save paths under test assert WHAT was
    // downloaded and how, and a no-op stub cannot report its own arguments.
    // `opts.download` is a function (or a {__reject} reply) that decides the
    // outcome per call, so a harness can make the picker cancel, refuse a
    // suggested filename, or fail outright.
    downloads: {
      download(dopts) {
        const call = Object.assign({}, dopts);
        downloadCalls.push(call);
        let r;
        try {
          r = typeof opts.download === 'function' ? opts.download(call) : opts.download;
        } catch (e) {
          r = Promise.reject(e);
        }
        if (r && r.__reject) return Promise.reject(new Error(r.error || 'download refused'));
        return Promise.resolve(r === undefined ? 42 : r);
      },
      // Nothing fires these by itself in a harness; a test that wants the
      // Layer-B view of a release's own restore pushes an item here.
      onCreated: { addListener(fn) { onCreated.push(fn); } },
      cancel(id) { downloadCalls.push({ action: 'cancel', id }); return Promise.resolve(true); },
      erase() { return Promise.resolve(); },
    },
  };

  class MO { constructor(fn) { this.fn = fn; } observe() {} disconnect() {} }
  const timers = [];
  const sandbox = {
    window, document: doc, browser, navigator: opts.navigator || { share: null },
    location: window.location, history: window.history,
    // Recorded, not discarded. A no-op console is a stub that cannot report
    // that the thing it stands in for is missing - which is exactly how a
    // privileged API that only exists in extension pages went unnoticed behind
    // an always-available `browser.menus` stub. C.5.
    console: {
      log(...a) { logs.push(['log', a.map(String).join(' ')]); },
      debug(...a) { logs.push(['debug', a.map(String).join(' ')]); },
      warn(...a) { logs.push(['warn', a.map(String).join(' ')]); },
      error(...a) { logs.push(['error', a.map(String).join(' ')]); },
    },
    MutationObserver: MO,
    // The REAL URL constructor, with just the two blob methods the file uses.
    // A plain object here would make `new URL(...)` throw, which the content
    // script catches and turns into "not a download" - a silent false negative
    // that looks like a policy failure rather than a broken harness.
    Blob: function Blob() {},
    URL: class FakeURL extends URL {
      static createObjectURL() { return 'blob:harness'; }
      static revokeObjectURL() {}
    },
    fetch: () => Promise.reject(new Error('no network')),
    setTimeout: (fn, ms) => { timers.push({ fn, ms }); return timers.length; },
    clearTimeout: () => {},
    Math, Date, JSON, Promise, Object, Array, String, Number, Boolean, RegExp, Error,
    Set, Map, isNaN, parseInt, parseFloat, encodeURIComponent, decodeURIComponent,
  };
  sandbox.self = sandbox;
  sandbox.globalThis = sandbox;
  return { sandbox, fire, storage, sent, onChanged, logs, replies, doc, window, documentElement, timers,
           downloadCalls, onCreated, assigned };
}

module.exports = { makeEnv, El, makeEvent };
