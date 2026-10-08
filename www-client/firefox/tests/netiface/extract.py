#!/usr/bin/env python3
"""Extract the per-URL rule code out of the real RozeLynxNetIface sources.

Nothing is reimplemented here: the harness compiles the ACTUAL text of the
matcher/parser and of GetEffective/MatchUrlRule, with only

  * the class name rewritten (RozeLynxNetIface:: -> FakeSvc::), so the same
    member bodies can be driven from a plain struct, and
  * the mozilla string/XPCOM surface replaced by the stand-ins in harness.cpp

so a bug in the shipped code fails the harness.  Function bodies are found by
brace counting from the real signature, so the extraction tracks the file
rather than a hard-coded line range.
"""

import os
import pathlib
import re
import sys

# Which tree to read the real service out of. RZ_TEST_ROOT wins, then the
# overlay's own files/ tree - tests/netiface/../../files/rozelynx - so this works
# from the source tree, the portage mirror, or the patch-tree backup without
# editing anything. It was an absolute path into /home/<user>/... before, which
# meant the harness silently tested whatever happened to be at that path rather
# than whatever was in the tree it was run from.
_HERE = pathlib.Path(__file__).resolve().parent
_DEFAULT = _HERE.parent.parent / "files" / "rozelynx"
ROOT = pathlib.Path(os.environ.get("RZ_TEST_ROOT") or _DEFAULT)

CPP = ROOT / "cpp/net-iface/RozeLynxNetIface.cpp"
HDR = ROOT / "cpp/net-iface/RozeLynxNetIface.h"

for _p in (CPP, HDR):
    if not _p.exists():
        sys.stderr.write(
            "FATAL: %s does not exist.\n"
            "Set RZ_TEST_ROOT to a tree containing files/rozelynx, or run this\n"
            "through tests/run.sh, which sets it for every tree it checks.\n"
            % _p)
        sys.exit(2)

cpp = CPP.read_text()
hdr = HDR.read_text()


def balanced(text, open_index, what):
    """Return text[open_index:] through the brace that closes it."""
    depth = 0
    for i in range(open_index, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[open_index:i + 1]
    sys.exit(f"unbalanced braces while extracting {what}")


def struct(text, name, what):
    m = re.search(rf"^struct {name} \{{", text, re.M)
    if not m:
        sys.exit(f"{what}: struct {name} not found")
    body = balanced(text, m.end() - 1, what)
    return f"struct {name} {body};"


def func(text, pattern, what):
    m = re.search(pattern, text, re.M)
    if not m:
        sys.exit(f"{what}: {pattern} not found")
    brace = text.index("{", m.start())
    # back up to the start of the line the signature begins on
    start = text.rfind("\n", 0, m.start()) + 1
    return text[start:brace] + balanced(text, brace, what)


def block(text, start_pat, end_pat, what):
    m = re.search(start_pat, text, re.M)
    if not m:
        sys.exit(f"{what}: start {start_pat} not found")
    e = re.search(end_pat, text[m.end():], re.M)
    if not e:
        sys.exit(f"{what}: end {end_pat} not found")
    return text[m.start():m.end() + e.end()].rstrip() + "\n"


def span(text, first_pat, last_pat, what):
    m = re.search(first_pat, text, re.M)
    if not m:
        sys.exit(f"{what}: {first_pat} not found")
    e = re.search(last_pat, text[m.end():], re.M)
    if not e:
        sys.exit(f"{what}: {last_pat} not found")
    return text[m.start():m.end() + e.end()].rstrip() + "\n"


def span_to_func(text, start_pat, last_func_pat, what):
    """From start_pat to the balanced end of the last_func_pat function."""
    m = re.search(start_pat, text, re.M)
    if not m:
        sys.exit(f"{what}: start {start_pat} not found")
    f = re.search(last_func_pat, text[m.end():], re.M)
    if not f:
        sys.exit(f"{what}: end {last_func_pat} not found")
    brace = text.index("{", m.end() + f.start())
    return text[m.start():brace] + balanced(text, brace, what)


parts = []

# 1. the rule struct, from the header
parts.append(("RozeLynxNetIfaceUrlRule (RozeLynxNetIface.h)",
              struct(hdr, "RozeLynxNetIfaceUrlRule", "rule struct")))

# 2. IsNeverBindHost - the URL layer's guard calls it, so it is part of it
parts.append(("IsNeverBindHost (RozeLynxNetIface.cpp)",
              func(cpp, r"^static bool IsNeverBindHost\(", "IsNeverBindHost")))

# 3. every URL-rule helper, in source order: the glob match, the target split,
#    the parser, the matcher and the specificity order.
parts.append(("URL-rule helpers (RozeLynxNetIface.cpp)",
              span_to_func(cpp, r"^// Host specificity ranks",
                           r"^static bool UrlRuleMoreSpecific\(",
                           "URL-rule helpers")))

# 3b. BuildUrlRulesLocked - the pref reader: grouping "<n>.field" back into
#     rules, the enabled default, the cap and the memo invalidation.
parts.append(("BuildUrlRulesLocked (RozeLynxNetIface.cpp)",
              func(cpp, r"^void RozeLynxNetIface::BuildUrlRulesLocked\(",
                   "BuildUrlRulesLocked")))

# 4. MatchUrlRuleLocked - the selection order and the memo
parts.append(("MatchUrlRuleLocked (RozeLynxNetIface.cpp)",
              func(cpp, r"^RozeLynxNetIfaceUrlRule\* RozeLynxNetIface::MatchUrlRuleLocked\(",
                   "MatchUrlRuleLocked")))

# 5. GetEffective - the layer order itself
parts.append(("GetEffective (RozeLynxNetIface.cpp)",
              func(cpp, r"^NS_IMETHODIMP\nRozeLynxNetIface::GetEffective\(",
                   "GetEffective")))

# 5b. AdditionalInfoForHost - the DNS-attribution path, whose index-miss
#     fallback is what keeps a rule-bound host from leaking DNS.
parts.append(("AdditionalInfoForHost (RozeLynxNetIface.cpp)",
              func(cpp, r"^NS_IMETHODIMP\nRozeLynxNetIface::AdditionalInfoForHost\(",
                   "AdditionalInfoForHost")))

# 6. MatchUrlRule - the IDL entry point the popup's match preview uses
parts.append(("MatchUrlRule (RozeLynxNetIface.cpp)",
              func(cpp, r"^NS_IMETHODIMP\nRozeLynxNetIface::MatchUrlRule\(",
                   "MatchUrlRule")))

# Where the generated .inc files go. RZ_EXTRACT_OUT lets the runner keep build
# artefacts out of the tree entirely; the default is beside this script so the
# extractor still works when run on its own. Generated extracts are never
# committed: a committed extract is a stale extract waiting to happen.
OUT = pathlib.Path(os.environ.get("RZ_EXTRACT_OUT") or pathlib.Path(__file__).parent)


def emit(fname, selected):
    chunks = []
    for title, body in selected:
        body = body.replace("RozeLynxNetIface::", "FakeSvc::")
        chunks.append(f"/* ==== {title} ==== */\n{body}\n")
    out = OUT / fname
    OUT.mkdir(parents=True, exist_ok=True)
    out.write_text("\n".join(chunks))
    print(f"wrote {out} ({sum(len(c) for c in chunks)} bytes)")
    for title, body in selected:
        print(f"  {len(body.splitlines()):4d} lines  {title}")


# The struct has to be visible before the harness's FakeSvc declaration; the
# member bodies have to come after it.
emit("extracted_types.inc", parts[:1])
emit("extracted_impl.inc", parts[1:])
