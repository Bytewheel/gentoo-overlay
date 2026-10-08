'use strict';
/* The WebExtension `runtime.onMessage` contract, which is the subtle part of
 * every background-module harness and the easiest thing to model wrongly.
 *
 * The real contract:
 *
 *   A listener that RETURNS true has claimed the message and will call
 *   sendResponse() later - possibly long later. A listener that returns
 *   anything else (false, undefined, a non-promise) has NOT claimed it, the
 *   message channel closes, and the SENDER's promise rejects with
 *   "Could not establish connection".
 *
 * Model that wrong - by treating "not handled" as "no reply yet" - and a test
 * for "this module ignores other modules' messages" hangs forever instead of
 * rejecting, which reads as a broken harness rather than a wrong model. That
 * is exactly what happened once already, so it lives here now.
 */

const NOT_HANDLED = 'Could not establish connection. Receiving end does not exist.';

/* Build a router over a set of registered onMessage listeners.
 *
 *   const router = messageRouter();
 *   router.add(fn);                       // as onMessage.addListener would
 *   browser.runtime.sendMessage = router.send;
 *
 * `send` resolves the message against the FIRST listener that claims it, in
 * registration order, and rejects if none does - which is what the real
 * runtime does.
 *
 * The deferred-reply branch had a bug that was latent until the first harness
 * to use an async reply (pwa-launcher-entries). It held the listener's callback
 * in one variable, `answered`, and then overwrote that same variable with the
 * promise's `resolve` from inside the executor:
 *
 *   const keep = fn(msg, sender, (r) => { answered = r; });
 *   if (keep === true) claimed = new Promise((resolve) => { answered = resolve; });
 *
 * The callback ASSIGNS (`answered = r`); it does not call. So after the
 * executor replaced `answered` with `resolve`, a listener's later sendResponse
 * stored its reply into `answered` and never called `resolve` - and the
 * sender's promise hung forever. A synchronous reply worked, because that path
 * reads `answered` before the executor runs, which is why nothing noticed:
 * every earlier harness that exercised this file happened to answer
 * synchronously, and the first one that did not hung with no error anywhere.
 *
 * So the callback consults the deferred resolver instead of being shadowed by
 * it, and the two reply paths are kept visibly separate. */
function messageRouter(opts) {
  opts = opts || {};
  const listeners = [];
  return {
    listeners: listeners,
    add(fn) { listeners.push(fn); },
    send(msg, sender) {
      let claimed = null;
      for (const fn of listeners) {
        // A reply made BEFORE the listener returned true, and the deferred one
        // it makes after. `deferred` is only non-null once the listener has
        // claimed the message.
        let sync = null;
        let deferred = null;
        const respond = (r) => {
          if (deferred) {
            const d = deferred;
            deferred = null;
            d(r);
          } else {
            sync = r;
          }
        };
        const keep = fn(msg, sender || {}, respond);
        if (keep === true) {
          claimed = new Promise((resolve) => { deferred = resolve; });
          break;
        }
        if (sync !== null) {
          claimed = Promise.resolve(sync);
          break;
        }
      }
      if (!claimed) {
        return Promise.reject(new Error(opts.notHandled || NOT_HANDLED));
      }
      return claimed;
    },
  };
}

/* The inverse direction: a stub whose `onMessage.addListener` records the
 * listener, and a `send` that goes through the contract above. This is what a
 * harness uses to talk to the code under test as if it were the runtime. */
function listenerStub() {
  const state = { listener: null, sent: [] };
  return {
    state: state,
    onMessage: { addListener(fn) { state.listener = fn; } },
    /* One-shot answer from a real listener: resolves with sendResponse's
     * value, rejects when the listener declines. */
    ask(msg, sender) {
      state.sent.push(msg);
      if (!state.listener) return Promise.reject(new Error(NOT_HANDLED));
      return new Promise((resolve, reject) => {
        let settled = false;
        const keep = state.listener(msg, sender || {}, (r) => {
          settled = true;
          resolve(r);
        });
        if (keep !== true && !settled) reject(new Error(NOT_HANDLED));
      });
    },
  };
}

module.exports = { messageRouter, listenerStub, NOT_HANDLED };
