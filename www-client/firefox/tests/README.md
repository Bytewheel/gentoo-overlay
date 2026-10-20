# `www-client/firefox` tests

2766 checks across ten harnesses, no dependencies beyond `node`, `python3`,
`clang++`, `bash`, `magick` and `base64`. They exist because this package has no
other way to be checked: the extension is `vm` code, the native host is Python,
the interface-binding service is C++, and the branding is shell inside an
ebuild. None of that is reachable from `bash -n` or a portage QA run.

    tests/run.sh              # source tree, a fresh assembly, and the portage mirror
    tests/run.sh --quick      # the source tree only
    tests/run.sh <root>...    # specific roots INSTEAD of the defaults

`run.sh` exits non-zero if any harness fails on any tree, and prints the total
check count when they all pass.

## These files are not in the `Manifest`, on purpose

`ebuild … manifest` writes a **thin** manifest: everything under `files/` is
`AUX` because that is `FILESDIR`, everything at the package top level is
`MISC`, and everything else is not recorded at all. A `tests/` directory
therefore appears in no digest line.

That is the right outcome rather than an oversight, and it was measured rather
than assumed — a probe directory under `files/` *is* recorded (`AUX probe/x.txt`),
and one at the top level is not. The alternatives were both worse:

- putting the harnesses under `files/rozelynx/` would make them `AUX` and so
  part of the tree the patch-tree backup mirrors as the shipped payload,
  which is not what they are;
- switching the repo to a **thick** manifest (`pkgcat manifest`, which does
  cover every file) changes what the `Manifest` *means* to portage for every
  consumer of the repo, and is not a decision to make for a set of developer
  tools.

Nothing here is a build input, nothing here is installed, and nothing here is
referenced by an ebuild, so the emerge is unaffected. The cost is that
`emerge --verify` does not checksum the harnesses; they are kept honest by
`run.sh` and by being mirrored to the other two trees.

## Why the same harness runs three times

A harness that only ever sees the source tree cannot tell you the assembled
extension still works — and the assembler, not the source directory, is what
decides what goes in the XPI. So the default run is:

1. **the source tree** — what a developer edits;
2. **a fresh assembly** of that tree, produced the way the ebuild produces it —
   what the ebuild actually packages;
3. **the portage mirror**, when it is present — what an emerge actually reads.

That third one is the one that catches a mirroring mistake, which is a mistake
no test can see and every emerge can.

## The harnesses

### The JavaScript legs — run against all three trees

| file | checks | what it drives |
|---|---:|---|
| `mouse-gestures-menu.js` | 74 | the synthetic right-click menu: the `RozeLynx` group, `parentId` nesting rebuilt into a real tree, per-extension headers, separators as separators, and the netiface entry (Parts C, C.3.1, E). **Section 12 runs the real `background.js` and the real `content.js` together, with and without `browser.menus`** (C.5) |
| `downloads-handoff-module.js` | 100 | the hand-off background page: the handler grammar, detection, ordered hand-off across all three transports, the interception gate, `set-handlers`/`set-enabled` (Part D.7) |
| `downloads-handoff-editor.js` | 112 | the handler editor in the popup plus the content script's link hook; section 11 runs the real editor and the real background **in one sandbox** (Part D.7) |
| `rozelynx-windows-api.js` | 225 | the `rozelynxWindows` experiment API. Sections 1-7 are the launcher-entry and PWA-icon writers against a fake `nsIFile` that **models Gecko instead of agreeing with the code** — `create()` makes a directory only for `DIRECTORY_TYPE`, `undefined` is coerced the way XPConnect coerces it, a child of a plain file cannot be opened (Part B.0 pass 1). Sections 8-10 are window resolution, written against the *observed* failure: a window whose sandbox `QueryInterface` throws must still reach the component via the IDL's own conversion, the fallback must match on `docShell.outerWindowID` and provably could not have matched on `window.windowID`, and the schema is pinned against the implementation (Part B.0 pass 2). Sections 12-13 are the v1.0.73 icon handling: `writeIconFile` derives the file **extension from the payload's magic bytes** (a PNG served as `application/octet-stream` must not fall back to the theme-name icon), and `hasDesktopEntry` reads the **`Icon=` key back** through real `nsIFileInputStream` fakes, reporting the value and whether the file an absolute value names still exists |
| `pwa-launcher-entries.js` | 176 | the PWA module's launcher-entry lifecycle, driving the **real** `pwa/background.js` and the **real** `windows-api.js` in one sandbox over a real temp directory, through the `runtime.onMessage` listener each registers. The pass under test is the module's own start-up reconcile, seeded before the module is evaluated — the production path. Assertions are about what is **on disk** (Part B.0 pass 2). Sections H-J are the v1.0.73 icon ladder: the packaged fallback artwork (`icons/pwa-fallback.png`) answers where the entry used to fall back to the theme name, candidate URLs the content script could not read (CORS) are re-fetched under the background's host permissions through modelled `Image`/`canvas` globals, a live tab favicon is harvested, a reconcile pass **upgrades** an entry whose `Icon=` fell behind (theme name, blank, or a dead path) without rewriting on a parent that reports no field, and `PWAManager.install` keeps the same ladder |
| `downloads-handoff-host.js` | 75 | the native messaging host's generic `handoff` / `handoff-probe` verbs, against real programs on `PATH`, plus the uGet verbs re-run so a change to the generic half cannot break the builtin |

`downloads-handoff-host.js` is exempt from the assembly run: the host is a
packaged file *beside* the extension, not part of the assembled output.

### The C++ and ebuild legs — run once, against the source tree

`netiface/run.sh` and `branding/run.sh` have a build or extraction step each, so
they run once rather than per tree; the JS legs above are what prove the three
trees agree.

| file | checks | what it drives |
|---|---:|---|
| `netiface/harness.cpp` | 201 | the real interface-binding service, with the real functions **extracted out of the real `.cpp` by brace counting from their real signatures** and `#include`d, so it cannot drift from the source |
| `netiface/structure.py` | 39 | the two resolver entry points the C++ harness cannot extract (they need a live `nsIChannel`) — asserts the **order** of the layers, which is the whole precedence promise |
| `netiface/ext.js` | 91 | the real `netiface-api.js`, `urlrules-ui.js` and `background.js` in a `vm` (Part F) |
| `branding/run.sh` | per slot | the real `src_prepare` branding block, run against a tree where **every slot is pre-filled with a `RED-STAND-IN` marker** — so "the file exists" is not evidence, and a slot still holding the marker means the block did not write it |

**Two properties of the C++ and branding legs that are easy to lose and were
lost once each:**

- *Nothing is committed that could go stale.* `netiface/*.inc` and
  `branding`'s extracted block are **generated on every run** and deliberately
  not checked in. A committed extract is a stale extract waiting to happen.
  This is not hypothetical: the previous branding harness read a **copy of the
  ebuild in `/tmp`** and kept passing for the rest of that session while testing
  a stale file, and took its subject with `sed -n '567,1008p'` — a line *window*
  that happened to contain the branding code, not a block. Its boundaries now
  come from `branding/extract-block.py`, which anchors on what the code says,
  asserts eight required markers, and **refuses to extract if the block reads a
  variable it never assigns** — the check that names the missing `local` instead
  of letting the block die on line one.
- *The subject is never anonymous.* The branding runner prints the ebuild's
  digest, and refuses a seed directory that names a different Firefox than the
  ebuild under test unless forced.

**The branding runner needs a real upstream `browser/branding/unofficial`**
(the block copies it). It looks for one at `$RZ_BRAND_SEED`, then in
`$XDG_CACHE_HOME/rozelynx-test-seed`, and builds the cache from
`/var/cache/distfiles/firefox-<PV>.source.tar.xz` if it has to — which streams
the whole 800 MB, once, and is why the cache exists. If none is available it
**fails loudly** rather than substituting another version's files.

## What these harnesses are, and are not

**They load the real files verbatim.** Nothing under test is reimplemented. A
`vm` context supplies `browser`, `Services`, a DOM and a timer; the file itself
is read from disk and run. When a check needs a value the stub has to have, the
stub grows that value — the file under test does not grow a seam.

**They are not vacuous, and the proof is mutation, not argument.** Each was run
against deliberately broken copies and each defect was caught:

| mutation | caught by |
|---|---|
| take the *last* available handler instead of the first | `4.4` |
| blank the stale handler indices instead of clearing them | `7.9` |
| promote a bare word to a program (the silent-exec hazard) | `1.6` + 9 more |
| accept an unknown handler id on write | `7.12` |
| report every handler available | editor `11.3`, `11.6`, `11.8b`, `11.15` |
| point a branding slot's write at a different path (still textually correct, no longer writes the slot) | the slot assertion, while the block itself still exits 0 |

Two of those six mutations were initially **no-ops** because they were written
at the wrong indentation or in the wrong place in the function — which is the
lesson worth keeping: a mutation that does not mutate proves nothing, so always
read the failure list and check the *count* moved.

**The C++ leg proved its own worth by refusing to run.** Recovered after
PART G, it did not compile: G.1.4 had changed the real service to use 156's
`Find`, `nsDependentCSubstring` and comparator-object `Sort`, and the
harness's *stand-in* platform still offered the pre-156 API. The stale thing was
the harness, not the code — which is G.1.4's own lesson ("a harness that
reimplements the platform is proof of the algorithm, never of the API") aimed at
the harness itself. The three stand-ins were brought up to date, and the
harness now compiles the *current* service rather than a pre-G.1.4 snapshot.

**The branding leg reproduced the plan's byte counts from source.** It generates
`about-logo.svg` at **79,375 B**, `cpm-fox-illustration.svg` at **184,788 B**
and the five installed icon sizes at 2969/4531/6690/9212/21683 B — the exact
figures PART G recorded by reading the **installed, built** tree. That is the
first time "what the ebuild does" and "what shipped" have been checked against
each other by a harness rather than by reading a build log.

**They cannot see anything a browser decides.** Whether the toolbox opens
docked, whether the WM honours a `WM_CLASS` set 1.5 s after creation, whether a
real download manager accepts what it is handed, and whether the editor reads
well at popup width are all compositor and window-manager questions. Every ⬜ in
`PLAN-SESSION-20` is one of those. The harnesses cover the code path up to the
call and nothing past it.

## `lib/`

Three small modules, each holding something that was got wrong at least once
and would otherwise be got wrong again in the next harness:

- **`check.js`** — the pass/fail recorder. Two properties: a recorded failure is
  never a crash (an early version dereferenced a value it had just asserted was
  present, so one mutation turned into a stack trace and the other 90 checks
  never ran), and a harness that dies before its summary reports `ABORTED` with
  exit 2 rather than looking like a pass.
- **`webext.js`** — the `runtime.onMessage` contract. Returning `true` means
  "I will answer later"; anything else means the channel closed and the
  *sender's* promise rejects. Model that wrong and a test for "this module
  ignores other modules' messages" hangs forever instead of rejecting.
- **`fakedom.js`** — a DOM that implements what the files under test touch and
  nothing else, so a missing method is loud. It exports the **real** `URL`
  constructor: a stub makes `new URL()` throw, the content script catches it,
  and "not a download" comes back — a silent false negative that looks like a
  policy failure rather than a broken harness.

- **`xpcomfile.js`** — a fake `nsIFile` / `nsIFileOutputStream` / `nsIEnvironment`
  / `nsIDirectoryService` backed by a **real temp directory**, added for
  `rozelynx-windows-api.js` and the reason that harness exists. `writeIconFile`
  used to call `dir.create(Ci.nsIFile.DIRECTORY, 0o755)`; `nsIFile` declares no
  `DIRECTORY` constant, so that was `undefined`, XPConnect coerced it to `0`,
  and `0` is `NORMAL_FILE_TYPE` — the call made an **empty plain file** where a
  directory belonged, and every write under it failed after that. It shipped,
  and it survived into a live profile. Every earlier fake modelled `create()` as
  "whatever the caller passed is a directory", which is the assumption that hid
  it: a stand-in for the platform that **agrees with the code under test cannot
  report that the platform disagrees with it**, the same lesson G.1.4 recorded
  for C++ and C.5 for the menus bridge, now on a faked filesystem API. So this
  one creates a directory *only* for `DIRECTORY_TYPE`, and the harness asserts
  the fake itself — so "fixing" it to agree with the bug fails the harness
  instead of hiding the bug.

- **`webext.js`'s `messageRouter` had never delivered an asynchronous reply**, and
  nothing noticed for a long time: it held the listener's callback in `answered`
  and then overwrote that same variable with the promise's `resolve` from inside
  the executor — and the callback *assigns* rather than calls, so a later
  `sendResponse` stored its reply and never called `resolve`. The sender's promise
  hung forever, silently. Synchronous replies worked, which is why it survived:
  every earlier harness that exercised the file's contract answered
  synchronously, and it had exactly one consumer. It was found when the first
  harness needing an async reply (`reconcile-entries` returns `true`) hung. This
  is the same lesson as `xpcomfile.js` one layer up — a model that does not match
  the contract produces confident nonsense rather than a failure — and it is
  recorded at the function.

`roots.js` resolves which tree a harness is pointed at, and fails loudly rather
than testing nothing: a harness pointed at a tree that does not exist would
otherwise report zero checks and exit 0, which is the one outcome a test runner
must never produce.

`netiface/` and `branding/` each have their own `run.sh` because each has a
build or extraction step. `netiface/extract.py` locates each function in the
real `.cpp` **by brace counting from its real signature**, so the extraction
tracks the file rather than a line number — the same lesson as
`branding/extract-block.py`, arrived at twice.

## Adding a check

1. Put it in the harness for the file it exercises. The section numbering is
   the check's own name (`'4.4 ...'`), which is what makes a mutation report
   readable.
2. If the stub needs a new capability, add it to `lib/` only if two harnesses
   want it; otherwise add it to the one harness that does.
3. Re-run `tests/run.sh` and **compare the check count** with what it was before.
   A count that moved without an intentional addition means a check stopped
   firing.
4. If the change is a behaviour change rather than a test change, prove the new
   check fails first — against a copy with the behaviour reverted. That is the
   only part of this that is easy to skip and impossible to recover from later.
