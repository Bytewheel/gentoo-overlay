#!/usr/bin/env bash
# Run every harness in this directory, against every tree that matters.
#
# The point of running the SAME harness against three roots is the property the
# whole verification story rests on: what ships is what was tested. A harness
# that only ever sees the source tree cannot tell you the assembled extension
# still works, and the assembler is the thing that decides what is in the XPI.
#
#   1. the overlay's source tree          - what a developer edits
#   2. a fresh assembly of that tree      - what the ebuild actually packages
#   3. the portage mirror, if present     - what an emerge actually reads
#
# The host harness is exempt from (2): the host is not part of the assembled
# extension, so there is nothing assembled to test it against.
#
# Usage:
#   tests/run.sh                 # source + assembly + mirror
#   tests/run.sh --quick         # source tree only
#   tests/run.sh <root>...       # specific roots instead
#
# Exit code is the number of failing harnesses, or 1 if any of them failed.

set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(dirname "${HERE}")"                       # .../www-client/firefox
MIRROR="/var/db/repos/bytewheel/www-client/firefox"
SCRATCH="$(mktemp -d "${TMPDIR:-/tmp}/rz-tests-XXXXXX")"
trap 'rm -rf "${SCRATCH}"' EXIT

QUICK=0
ROOTS=()
for a in "$@"; do
	case "$a" in
		--quick) QUICK=1 ;;
		*) ROOTS+=("$a") ;;
	esac
done

# The JavaScript harnesses: fast, and each takes the tree root as argv[2].
HARNESSES=(
	"mouse-gestures-menu"
	"downloads-handoff-module"
	"downloads-handoff-editor"
	"downloads-handoff-content"
	"rozelynx-windows-api"
	"pwa-launcher-entries"
	"security-canvas"
	"qr-popup-layout"
	"qr-popup-theme"
	"ext-menus-patch"
	"external-link-chooser"
)
# The C++/mixed harnesses take a tree CONTAINING files/rozelynx, so they read
# RZ_TEST_ROOT rather than argv, and have their own runners because each one has
# a build or extraction step of its own.
SUBHARNESSES=(
	"netiface/run.sh"
	"branding/run.sh"
)

red()   { printf '\033[31m%s\033[0m\n' "$*"; }
green() { printf '\033[32m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

failures=0
checks_total=0
declare -A results

# Add the check count a harness reported to the running total. Parsed once, as
# the result arrives, with bash arithmetic: the earlier version re-parsed every
# result at the end through sed|paste|bc, which produced an empty string for a
# harness whose verdict is a sentence rather than a count, and took the whole
# script down with an arithmetic error on an otherwise clean run.
# One matcher for every report shape the harnesses use, with or without a colon
# and with or without the word "checks":
#   "mouse-gestures-menu: 60 passed, 0 failed"
#   "   201 checks passed, 0 failed"
#   "   39 structural checks passed, 0 failed"
# A harness whose verdict is a sentence rather than a count contributes nothing,
# which is correct - there is no number to add.
count_of() {
	printf '%s' "$1" |
		sed -n 's/.*[^0-9]\([0-9][0-9]*\) \(checks \|structural checks \)\{0,1\}passed.*/\1/p' |
		head -1
}

# Assemble the extension the way the ebuild does, so (2) is real output and not
# a copy of the sources.
bold "== assembling (this is what the ebuild packages) =="
# external-link is in the test assembly for the same reason it is in the
# ebuild's (USE=pwa): the chooser harness reads modules/external-link, and an
# assembly without it would send that leg straight to its FATAL path instead
# of proving the shipped bytes pass.
if python3 "${PKG}/files/rozelynx/extension/assemble-extension.py" \
	--extension-dir "${PKG}/files/rozelynx/extension" \
	--output-dir "${SCRATCH}/asm" \
	--enable pwa,qr-code,net-iface,mouse-gestures,download-handoff,external-link \
	>"${SCRATCH}/asm.log" 2>&1; then
	green "   ok"
else
	red "   FAILED - see below"
	sed 's/^/   | /' "${SCRATCH}/asm.log"
	exit 1
fi

# An explicit root REPLACES the default set. Appending to it would mean
# `run.sh /some/broken/tree` quietly also reported the three good ones, and a
# failure would scroll past in a wall of green.
if [ "${QUICK}" -eq 1 ]; then
	ROOTS=("${PKG}/files/rozelynx/extension")
elif [ "${#ROOTS[@]}" -eq 0 ]; then
	ROOTS=("${PKG}/files/rozelynx/extension" "${SCRATCH}/asm")
	[ -d "${MIRROR}/files/rozelynx" ] && ROOTS+=("${MIRROR}/files/rozelynx/extension")
fi

for root in "${ROOTS[@]}"; do
	case "${root}" in
		"${SCRATCH}/asm") label="assembled" ;;
		"${MIRROR}"*)     label="portage mirror" ;;
		*)                label="source tree" ;;
	esac
	bold "== ${label} =="
	echo "   ${root}"
	for h in "${HARNESSES[@]}"; do
		out="$(node "${HERE}/${h}.js" "${root}" 2>&1)"
		line="$(printf '%s\n' "${out}" | tail -1)"
		if printf '%s' "${out}" | grep -qE ': [0-9]+ passed, 0 failed$'; then
			green "   ${line}"
			_c="$(count_of "${line}")"
			checks_total=$((checks_total + ${_c:-0}))
		else
			red "   ${line}"
			printf '%s\n' "${out}" | sed 's/^/      | /'
			failures=$((failures + 1))
		fi
		results["${h}@${label}"]="${line}"
	done
done

# The host is a packaged file beside the extension, not part of the assembly.
bold "== native host =="
out="$(node "${HERE}/downloads-handoff-host.js" 2>&1)"
line="$(printf '%s\n' "${out}" | tail -1)"
if printf '%s' "${out}" | grep -qE ': [0-9]+ passed, 0 failed$'; then
	green "   ${line}"
	_c="$(count_of "${line}")"
	checks_total=$((checks_total + ${_c:-0}))
else
	red "   ${line}"
	printf '%s\n' "${out}" | sed 's/^/      | /'
	failures=$((failures + 1))
fi

# The --ssb command-line handler, same reasoning as the host: it ships in
# files/rozelynx/cpp/, not in the extension, so there is nothing per-tree to
# compare. It is here rather than in the extension loop because it is the file
# that makes a generated .desktop entry do anything, and it shipped two
# showstopping defects with no harness touching it at all - see the header of
# tests/ssb-command-line-handler.js.
bold "== ssb command-line handler =="
out="$(node "${HERE}/ssb-command-line-handler.js" 2>&1)"
line="$(printf '%s\n' "${out}" | tail -1)"
if printf '%s' "${out}" | grep -qE ': [0-9]+ passed, 0 failed$'; then
	green "   ${line}"
	_c="$(count_of "${line}")"
	checks_total=$((checks_total + ${_c:-0}))
else
	red "   ${line}"
	printf '%s\n' "${out}" | sed 's/^/      | /'
	failures=$((failures + 1))
fi

# The C++ and ebuild-block harnesses run ONCE, against the source tree: the
# first compiles C++ out of it and the second extracts shell out of the ebuild,
# and both are slow enough that repeating them per tree buys nothing. The
# JavaScript legs above are what prove the three trees agree.
for sub in "${SUBHARNESSES[@]}"; do
	name="${sub%%/*}"
	bold "== ${name} =="
	# The EXIT CODE is the verdict. An earlier version also grepped the output
	# for "0 failed", which is wrong twice over: it re-decides what the exit
	# code already decided, and the branding harness has no such line to grep
	# because its verdict is a sentence about slots.
	if out="$(RZ_TEST_ROOT="${PKG}/files/rozelynx" "${HERE}/${sub}" 2>&1)"; then
		# Show the counts each one reports, indented, without re-colouring:
		# the sub-harness has already coloured its own output.
		printf '%s\n' "${out}" \
			| grep -E '[0-9]+ (checks|structural checks) passed|all slots written' \
			| sed 's/^/   /' | sed 's/\x1b\[[0-9;]*m//g'
		# The netiface runner reports three counts on three lines; the branding
		# one reports a sentence and contributes 0 here, because its assertions
		# are per-slot and are counted by its own output.
		# Read LINE by line. An earlier version did
		#   for _line in $(printf '%s\n' "${out}")
		# which splits on IFS and therefore shreds "  201 checks passed" into
		# the bare word "201", which then matches nothing - and the symptom
		# was a total quietly 331 short with no error anywhere.
		_n=0
		while IFS= read -r _line; do
			_c="$(count_of "${_line}")"
			[ -n "${_c}" ] && _n=$((_n + _c))
		done <<< "${out}"
		checks_total=$((checks_total + _n))
	else
		printf '%s\n' "${out}" | sed 's/^/      | /'
		failures=$((failures + 1))
	fi
done

echo
if [ "${failures}" -eq 0 ]; then
	green "all harnesses passed on every tree"
	# A total, because "everything passed" is more convincing with a number
	# against it and costs nothing to compute.
	echo "   (${checks_total} checks: the JS/host harnesses across three trees,"
	echo "    plus the netiface C++/structural/JS legs and the branding block)"
	exit 0
fi
red "${failures} harness/tree pair(s) failed"
exit 1
