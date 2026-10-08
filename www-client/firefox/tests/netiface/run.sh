#!/usr/bin/env bash
# The netiface service harness: 201 behavioural checks over the REAL C++,
# 64 structural checks over the resolver entry points the C++ harness cannot
# extract (ResolveForChannel, ResolveForWebSocket and the shared ResolveForLoad
# body they delegate to, plus ResolveForOriginAttributes), and 94 checks over
# the real extension-side JavaScript.
#
# The behavioural half works by EXTRACTING the real functions out of the real
# .cpp and #including them, so it cannot drift from the source: extract.py
# locates each one by brace counting from its real signature. The .inc files
# are therefore generated here and are deliberately not checked in - a
# committed extract is a stale extract waiting to happen, which is the exact
# bug the branding harness had (it tested a months-old copy of the ebuild and
# reported success).
#
# Usage:  tests/netiface/run.sh
# Env:    RZ_TEST_ROOT - a tree containing files/rozelynx (default: the overlay's)
set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${RZ_TEST_ROOT:-$(cd "${HERE}/../.." && pwd)/files/rozelynx}"
CXX="${CXX:-clang++}"
rc=0

# Everything this leg GENERATES goes in a scratch directory, never in the tree.
# An earlier version compiled `harness` and wrote the .inc files in place, and
# the next `cp -r` of tests/ into the portage mirror carried a compiled binary
# and a stale extract along with it - which is the same "a committed build output
# is a stale build output" mistake this harness exists to catch, made by the
# harness. A .gitignore covers git; it does not cover a plain directory copy.
WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

bold "netiface: extracting the real service out of ${ROOT}"
if ! RZ_EXTRACT_OUT="${WORK}" python3 "${HERE}/extract.py" >/dev/null; then
	red "   extract failed"
	exit 2
fi
green "   ok"

bold "netiface: compiling the behavioural harness"
# -fsanitize is NOT on by default: the ASan build is a second opinion run
# deliberately, because it needs a leak detector off (RefPtr::forget leaks by
# design in this stand-in plumbing) and a sanitizer run that is always on makes
# a real leak look like noise.
if ! "${CXX}" -std=c++17 -O1 -g -Wall -I"${WORK}" -o "${WORK}/harness" \
		"${HERE}/harness.cpp" 2>"${WORK}/build.log"; then
	red "   compile failed:"
	sed 's/^/      | /' "${WORK}/build.log"
	exit 2
fi
if [ -s "${WORK}/build.log" ]; then
	# Warnings are shown, not swallowed: this file is the one place a
	# -Wthread-safety-analysis change would show up before an emerge.
	sed 's/^/      | /' "${WORK}/build.log"
fi
green "   ok"

bold "netiface: behavioural"
if out="$("${WORK}/harness" 2>&1)"; then
	green "   $(printf '%s\n' "${out}" | tail -1)"
else
	red "   $(printf '%s\n' "${out}" | tail -1)"
	printf '%s\n' "${out}" | sed 's/^/      | /'
	rc=1
fi

bold "netiface: structural"
if out="$(python3 "${HERE}/structure.py" 2>&1)"; then
	green "   $(printf '%s\n' "${out}" | tail -1)"
else
	red "   $(printf '%s\n' "${out}" | tail -1)"
	printf '%s\n' "${out}" | sed 's/^/      | /'
	rc=1
fi

bold "netiface: extension side"
if out="$(node "${HERE}/ext.js" 2>&1)"; then
	green "   $(printf '%s\n' "${out}" | grep -E '[0-9]+ checks' | tail -1)"
else
	red "   $(printf '%s\n' "${out}" | tail -3 | sed 's/^/      | /')"
	rc=1
fi

exit "${rc}"
