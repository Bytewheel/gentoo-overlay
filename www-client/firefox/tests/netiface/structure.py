#!/usr/bin/env python3
"""Structural checks on the resolver entry points the C++ harness cannot
extract (they need a live nsIURI / nsIChannel / nsILoadInfo).

ResolveForChannel and ResolveForWebSocket are thin wrappers that unpack their
arguments and tail-call one shared body, ResolveForLoad, so the layer ladder
is asserted there. These assert the ORDER of the layers in the shipped source,
because the whole F.1 precedence promise is about order:
tab > url > container > profile.
"""

import os
import pathlib
import re
import sys

# Same convention as extract.py: RZ_TEST_ROOT, else the overlay's own tree, so
# this reads whatever tree the runner pointed it at rather than a fixed path.
_HERE = pathlib.Path(__file__).resolve().parent
_ROOT = pathlib.Path(os.environ.get("RZ_TEST_ROOT")
                     or (_HERE.parent.parent / "files" / "rozelynx"))
CPP = _ROOT / "cpp/net-iface/RozeLynxNetIface.cpp"
IDL = CPP.with_name("nsIRozeLynxNetIface.idl")
HDR = CPP.with_name("RozeLynxNetIface.h")

cpp = CPP.read_text()
idl = IDL.read_text()
hdr = HDR.read_text()

fails = []
passes = 0

# The necko patch is checked as TEXT, not as a build: no compiled browser is
# available here, and this leak was invisible to every other test because the
# failure is a wrong-interface egress rather than a wrong answer. A tab bound to
# one interface still resolves correctly - it just asks the wrong resolver.
#
# The specific regression: both resolve sites passed `nullptr` as the DNS
# additional-info argument, which is legal and means "no interface". The socket
# was bound further down, so nothing complained, and the name went out on the
# default route. Observed live as `bindIf=- info=0 flags=79872` (0x13800 =
# IGNORE_SOCKS_DNS | TRR_DISABLED | WANT_RECORD_ON_ERROR, unique to the
# DnsAndConnectSocket seam) and 0x3800 for the nsSocketTransport one.
PATCH = _ROOT / "cpp/net-iface/net-iface-necko.patch"
patch_text = PATCH.read_text()

# Every AsyncResolveNative call the patch's own hunks leave in place must not
# hand a bare nullptr to the additional-info parameter. Look only at lines the
# patch ADDS or keeps as context, so this says nothing about stock call sites
# the patch never meant to touch.
# Reconstruct each target file's patched text (context + added lines in order,
# leading diff char stripped) and search INSIDE each AsyncResolveNative call.
# A per-line search does not work, and silently passed with the bug still
# present: the call spans eight lines and the nullptr sits on a different one
# from the function name, so "a line containing both" is never true.
rebuilt = {}
cur = None
for line in patch_text.splitlines():
    if line.startswith("+++ b/"):
        cur = line[6:]
        rebuilt.setdefault(cur, [])
        continue
    if line.startswith("diff --git"):
        cur = None
        continue
    if cur and line.startswith(("+", " ")) and not line.startswith("+++"):
        rebuilt[cur].append(line[1:])

TARGETS = ("netwerk/protocol/http/DnsAndConnectSocket.cpp",
           "netwerk/base/nsSocketTransport2.cpp",
           "netwerk/protocol/http/HappyEyeballsConnectionAttempt.cpp")

leaks = []
for _f in TARGETS:
    _text = "".join(rebuilt.get(_f, []))
    for _m in re.finditer(r"AsyncResolveNative\(", _text):
        _end = _text.find(");", _m.end())
        _call = _text[_m.end():_end if _end != -1 else _m.end() + 400]
        if re.search(r"(?<![A-Za-z0-9_])nullptr(?![A-Za-z0-9_])", _call):
            leaks.append(_f.rsplit("/", 1)[-1] + ": " + _call.strip()[:90])


def check(ok, what, detail=""):
    """`detail` is shown only on failure. The existing call sites pass two
    arguments; the resolve-site checks added below want to say what was found,
    which is the whole value of a leak assertion - "it failed" is not actionable
    when the failure is "somebody passed nullptr somewhere".
    """
    global passes
    if ok:
        passes += 1
    else:
        fails.append(f"{what} :: {detail}" if detail else what)


def body(text, pattern):
    m = re.search(pattern, text, re.M)
    if not m:
        sys.exit(f"marker not found: {pattern}")
    depth = 0
    start = text.index("{", m.start())
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    sys.exit("unbalanced braces")


# ── the entry points: thin wrappers over one shared body ───────────
# ResolveForChannel and ResolveForWebSocket (the admission-DNS entry the
# necko patch calls from WebSocketChannel::DoAdmissionDNS) both just unpack
# their arguments and tail-call ResolveForLoad. The layer ladder therefore
# exists in exactly one place: a copy in either wrapper is precisely the
# drift the split exists to prevent, because the WebSocket admission lookup
# must answer with the same precedence its own handshake channel gets, or a
# ws:// load egresses differently than the transaction it admits.
chan = body(cpp, r"^bool RozeLynxNetIface::ResolveForChannel\(")
ws = body(cpp, r"^bool RozeLynxNetIface::ResolveForWebSocket\(")
check("ResolveForLoad(uri, loadInfo, aOut)" in chan,
      "ResolveForChannel: delegates to the shared ResolveForLoad")
check("ResolveForLoad(aURI, aLoadInfo, aOut)" in ws,
      "ResolveForWebSocket: delegates to the shared ResolveForLoad")
for name, text in (("ResolveForChannel", chan), ("ResolveForWebSocket", ws)):
    check(not any(n in text for n in
                  ("mTabMap.Lookup", "MatchUrlRuleLocked", "mContainerMap.Lookup",
                   "mProfileIface")),
          f"{name}: carries no layer of its own (the ladder lives only in "
          "ResolveForLoad)")
check("static bool ResolveForWebSocket(" in hdr,
      "header: the WebSocket entry point is declared")
check("static bool ResolveForLoad(" in hdr,
      "header: the shared body is declared")
# Declared is not wired. The patch must actually call ResolveForWebSocket at
# the admission site - otherwise it is the same declared-but-inert API the
# TLSTransportLayer accessors below turned out to be. The string is
# RozeLynx-namespaced, so it can only ever appear in lines the patch adds.
check("RozeLynxNetIface::ResolveForWebSocket(" in patch_text,
      "necko patch: the WebSocket admission lookup calls ResolveForWebSocket")

# ── ResolveForLoad: tab > url > container > profile ─────────────────
load = body(cpp, r"^bool RozeLynxNetIface::ResolveForLoad\(")
order = [
    ("tab layer", "svc->mTabMap.Lookup(browserId)"),
    ("url layer", "svc->MatchUrlRuleLocked("),
    ("container layer", "svc->mContainerMap.Lookup(attrs.mUserContextId)"),
    ("profile layer", "svc->mProfileIface"),
]
pos = -1
for label, needle in order:
    at = load.find(needle)
    check(at >= 0, f"ResolveForLoad: {label} present")
    check(at > pos, f"ResolveForLoad: {label} comes after the previous layer")
    pos = max(pos, at)

# The URL layer must sit after the never-bind early return, or a rule could
# bind a loopback/LAN host.
check(
    load.find("IsNeverBindHost(rozelynxHost)") < load.find("svc->MatchUrlRuleLocked("),
    "ResolveForLoad: the never-bind guard runs before the url layer",
)
# ... and it must be inside the same lock scope as the other layers.
check("MutexAutoLock lock(svc->mMutex);" in load, "ResolveForLoad: still locked")
# ... and the scheme/path must be fetched lazily, inside the layer.
check(
    load.find("aURI->GetScheme(scheme)") > load.find("if (svc->mUrlRulesEnabled"),
    "ResolveForLoad: the scheme is fetched only when rules exist",
)
# The chosen interface still flows into the host index, so a URL-rule egress
# is what later DNS lookups are attributed to. Both entry points share this
# body, so the admission lookup records the same attribution a channel would.
check(
    load.find("RecordHostBinding(rozelynxHost, aOut)") > load.find("MatchUrlRuleLocked("),
    "ResolveForLoad: the url-layer result is recorded in the host index",
)

# ── ResolveForOriginAttributes must stay URL-free and say so ───────
origin = body(cpp, r"^bool RozeLynxNetIface::ResolveForOriginAttributes\(")
check("MatchUrlRuleLocked" not in origin,
      "ResolveForOriginAttributes: no url layer (no host is available)")
check("KNOWN LIMITATION" in origin,
      "ResolveForOriginAttributes: the limitation is documented in the code")

# ── GetEffective: the IDL and the implementation must agree ────────
eff = body(cpp, r"^RozeLynxNetIface::GetEffective\(")
eff_order = [
    ("tab", "mTabMap.Lookup(aBrowserId)"),
    ("url", "MatchUrlRuleLocked(key"),
    ("container", "mContainerMap.Lookup(aUserContextId)"),
    ("profile", "mProfileIface"),
]
pos = -1
for label, needle in eff_order:
    at = eff.find(needle)
    check(at >= 0, f"GetEffective: {label} layer present")
    check(at > pos, f"GetEffective: {label} layer comes after the previous one")
    pos = max(pos, at)
check('aLayer.AssignLiteral("url")' in eff, 'GetEffective: reports layer "url"')

idl_get = re.search(r"AUTF8String getEffective\([^;]*;", idl, re.S).group(0)
check("in AUTF8String aHost" in idl_get, "IDL: getEffective takes aHost")
check("out AUTF8String aLayer" in idl_get, "IDL: getEffective still reports a layer")
check("matchUrlRule" in idl, "IDL: matchUrlRule is declared")
check(
    re.search(r"boolean matchUrlRule\(in AUTF8String aUrl, out long aIndex,\s*"
              r"out AUTF8String aPattern, out AUTF8String aIface\);", idl, re.S)
    is not None,
    "IDL: matchUrlRule's out-params are the index, pattern and interface",
)

# ── AdditionalInfoForHost: the index-miss fallback ─────────────────
info = body(cpp, r"^RozeLynxNetIface::AdditionalInfoForHost\(")
check(
    info.find("mHostIndex.Lookup(host)") < info.find("MatchUrlRuleLocked("),
    "AdditionalInfoForHost: the host index is still consulted first",
)
check(
    "host index miss" in info and "fromRule" in info,
    "AdditionalInfoForHost: a rule match counts as attributed",
)
check(
    info.find("if (!indexed && !fromRule)") < info.find("if (iface.IsEmpty())"),
    "AdditionalInfoForHost: the empty-iface bail still applies to a rule",
)

# ── the memo can never outlive the rules it indexes ────────────────
build = body(cpp, r"^void RozeLynxNetIface::BuildUrlRulesLocked\(")
check("mUrlRuleMemoKey.Truncate();" in build and "mUrlRuleMemoIndex = -1;" in build,
      "BuildUrlRulesLocked: the memo is cleared with the vector")
check(build.index("mUrlRules.Clear()") < build.index("mUrlRuleMemoKey.Truncate()"),
      "BuildUrlRulesLocked: the vector is cleared before the memo")
# The parser must never be handed the struct it also reads from.
check(
    "RozeLynxNetIfaceUrlRule parsed;" in build
    and "UrlRuleParsePattern(entry.rule.pattern, parsed)" in build,
    "BuildUrlRulesLocked: the parser is not called with its own output as input",
)
check("parsed.iface = entry.rule.iface;" in build
      and "parsed.enabled = entry.rule.enabled;" in build
      and "parsed.index = (uint32_t)entry.index;" in build,
      "BuildUrlRulesLocked: the pref-read fields are carried onto the parsed rule")

update = body(cpp, r"^void RozeLynxNetIface::UpdateCachedState\(")
check("BuildUrlRulesLocked();" in update,
      "UpdateCachedState: rebuilds the url rules from prefs")
check("mContainerMap.Clear();" in update and "mTabMap" not in update.split("BuildUrlRulesLocked();")[0].split("mContainerMap.Clear();")[1][:400],
      "UpdateCachedState: mTabMap is still left alone (v13 invariant)")

# ── the header must document the grammar and the pref layout ───────
check("rozelynx.netiface.urlrule.<n>.pattern" in hdr, "header: pattern pref documented")
check("rozelynx.netiface.urlrules.enabled" in hdr, "header: master switch documented")
check("kMaxUrlRules" in hdr and "kMaxUrlRules" in build, "header/cpp: the cap agrees")

# ── no site may force TRR-only for a bound record with no resolver ──
#
# This is the WebSocket break, and it is a class of bug rather than a typo, so
# the check is on the RULE rather than on any one line: every place the patch
# forces TRR-only (or denies the native retry) for an interface-bound record
# must also test that a trrServer actually exists.
#
# The failure it prevents is silent and total.  TRR-only has no native
# fallback, and the netiface code additionally refuses the native retry, so a
# bound record with an empty trrServer can never be satisfied by anything.  A
# profile that binds an interface without configuring DoH (neither
# rozelynx.netiface.trr.uri.<ifname> nor network.trr.uri) therefore lost every
# hostname needing a fresh lookup, while hosts already in the DNS cache kept
# working - which is why it presented as one broken WebSocket rather than as a
# general DNS outage.  SO_BINDTODEVICE was not involved: where the bound
# interface is also the default route, binding is a no-op.
patch = (CPP.parent / "net-iface-necko.patch")
patched = patch.read_text()

# Strip the leading '+' so these read as the C++ they will become.
added = "\n".join(l[1:] for l in patched.split("\n") if l.startswith("+"))

def guard_present(anchor):
    """The forced-TRR site at `anchor` must test mTrrServer IN ITS CONDITION.

    Deliberately spans only the condition, not the surrounding 400 characters.
    A wider window passes on unrelated mTrrServer text elsewhere in the hunk,
    which is how the first version of this check came to be one that could not
    fail - a green check nobody can make red is the exact failure mode this
    file exists to prevent.
    """
    m = re.search(re.escape(anchor), added)
    if not m:
        return None
    brace = added.find("{", m.start())
    cond = added[m.start():brace] if brace != -1 else ""
    # A multi-line condition ends at the first line that closes it.
    return "mTrrServer.IsEmpty()" in cond

for anchor, what in (
    ("if (!rec->mBindIface.IsEmpty() &&",
     "NameLookup: forcing TRR-only for a bound record is gated on mTrrServer"),
    ("if (!aAddrRec->mBindIface.IsEmpty() &&",
     "MaybeRetryTRRLookup: denying the native retry is gated on mTrrServer"),
):
    # `is True`, not `is not False`. Removing the guard changes the anchor line
    # itself, so the site stops matching and guard_present returns None - and an
    # `is not False` test scores that as a PASS. A check that goes green when
    # the thing it watches is deleted is worse than no check, which is the
    # lesson of this whole session; a missing site is a failure, reported as
    # its own distinct message so it cannot be mistaken for the other one.
    got = guard_present(anchor)
    check(got is not None, what + " [the guarded site itself is missing]")
    check(got is True, what)

# The channel path must make the same decision, for the same reason.
check("GetEffectiveTrrURI(rozelynxBindIface, rozelynxResolverURL)" in added
      and "if (!rozelynxResolverURL.IsEmpty()) {" in added,
      "nsHttpChannel::BeginConnect: TRR-only is gated on a resolver existing")

# One helper owns the fallback, so the five open-coded copies cannot diverge
# again - that divergence is how the channel path came to force TRR with an
# empty URI while the extension path checked.
check("GetEffectiveTrrURI" in hdr and "static void GetEffectiveTrrURI" in hdr,
      "header declares the single GetEffectiveTrrURI helper")
check("void RozeLynxNetIface::GetEffectiveTrrURI(" in cpp
      and "GetIfaceTrrURI(aIface, aOut);" in cpp,
      "GetEffectiveTrrURI: per-interface pref first")
check(re.search(r"void RozeLynxNetIface::GetEffectiveTrrURI\(.*?\n\}", cpp, re.S)
      is not None
      and "TRRService::Get()->GetURI(aOut);" in
      re.search(r"void RozeLynxNetIface::GetEffectiveTrrURI\(.*?\n\}", cpp, re.S).group(0),
      "GetEffectiveTrrURI: falls back to the global network.trr.uri, and only that")

# ── no transport may be enabled for a bound connection unless it can bind ──
#
# The second silent leak, and the same shape as the first: a transport that
# cannot carry SO_BINDTODEVICE must never be used for a bound connection.
#
# SO_BINDTODEVICE is applied in exactly two places - nsSocketTransport::
# InitiateSocket and nsUDPSocket. DirectTLS is neither: SetupSecondaryTLS
# installs a TLSTransportLayer whose socket comes from the "ssl" socket
# provider as a raw PR_OpenTCPSocket inside NSS, so it never becomes an
# nsSocketTransport and InitiateSocket is never reached. A bound connection
# taking that path resolved over the bound DoH channel and then egressed on
# the ambient default route, with every log line still naming the interface.
#
# The patch had already added a Get/SetBindIface pair and a member to
# TLSTransportLayer and never used them, which is what made it look handled.
# Two checks, so neither the accessor nor the exclusion can drift alone:
# the accessor is inert, and the path that would need it is switched off.
# Anchor on the guard this patch ADDS, not on the SetupSecondaryTLS() call -
# that call is unchanged context, so it is not present in the added-line view
# at all, and searching for it here reported the site as missing. The guard is
# the thing that has to exist.
guard = "if (mConnInfo->GetBindIface().IsEmpty() &&"
m_guard = added.find(guard)
check(m_guard != -1,
      "nsHttpConnection: secondary TLS is gated on the connection being unbound")
if m_guard != -1:
    # ...and the gate must actually wrap the secondary-TLS branch, not sit
    # somewhere harmless. Within the same added block, the unchanged
    # SetupSecondaryTLS() call follows the guard's closing paren.
    after = added[m_guard:m_guard + 400]
    check("UsingHttpsProxy()" in after and "NS_HTTP_TLS_TUNNEL" in after,
          "nsHttpConnection: the gate wraps the proxy-COMNECT/TLS-tunnel branch")
    check(after.find("UsingHttpsProxy()") < after.find("NS_HTTP_TLS_TUNNEL") + 200,
          "nsHttpConnection: the gate is on the same condition as that branch")

tls = re.search(r"TLSTransportLayer::SetBindIface.*?\n\}", added, re.S)
check(tls is not None, "TLSTransportLayer: SetBindIface is present")
check(tls is not None and "setsockopt" not in tls.group(0),
      "TLSTransportLayer: its SetBindIface is inert (no setsockopt) - which is "
      "exactly why the path must be skipped for bound connections")

# And the two real bind sites must still be there: the check above is only
# meaningful while those are the places the bind actually happens.
check(added.count("SO_BINDTODEVICE, bindIface.get()") == 2,
      "exactly two sites apply SO_BINDTODEVICE (nsSocketTransport, nsUDPSocket)")

for f in fails:
    print(f"  FAIL  {f}")
# ── the resolve sites must not drop the interface ──
check(not leaks,
      "no resolve site in the patched DnsAndConnectSocket / nsSocketTransport2 / "
      "HappyEyeballs passes a bare nullptr as DNS additional info",
      (f"{len(leaks)} site(s): " + " | ".join(leaks[:3])) if leaks else
      "every AsyncResolveNative in those files carries an interface-bearing info")

for fname in ("netwerk/protocol/http/DnsAndConnectSocket.cpp",
              "netwerk/base/nsSocketTransport2.cpp"):
    n = patch_text.count('rozelynxInfo')
    check(n >= 3, f"{fname.rsplit('/', 1)[-1]} builds and passes rozelynxInfo",
          f"{n} references")

check('DNSAdditionalInfo.h' in patch_text,
      "the patch includes DNSAdditionalInfo.h where it constructs the info",
      "otherwise the 3-arg constructor is invisible")


print(f"{passes} structural checks passed, {len(fails)} failed")
sys.exit(1 if fails else 0)
