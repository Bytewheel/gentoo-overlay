#!/usr/bin/env bash
# The src_prepare branding block, run for real against a poisoned tree.
#
# The block does `cp -a browser/branding/unofficial browser/branding/rozelynx`
# and then overwrites slots inside the copy, so the assertions that matter are
# about which slots got written - not which exist. Every slot is therefore
# pre-filled with a RED-STAND-IN marker, and "the file is there" is not evidence
# of anything. A slot still holding the marker means the block did not write it.
#
# Two bugs in the previous version of this harness are fixed here, and both are
# the kind that report success:
#
#   1. It read a COPY of the ebuild out of /tmp. For the rest of that session it
#      kept passing while testing a stale file. It now reads the ebuild in the
#      tree, and prints its digest so the subject is never anonymous.
#   2. It took `sed -n '567,1008p'` - a line WINDOW, not a block, which happened
#      to contain the branding code. Boundaries now come from
#      extract-block.py, which anchors on what the code says and exits 2 rather
#      than emitting a slice that might be empty.
#
# Usage:  tests/branding/run.sh
# Env:
#   RZ_TEST_ROOT   - tree containing files/rozelynx (default: the overlay's)
#   RZ_BRAND_SEED  - a pre-extracted browser/branding/unofficial directory
#   RZ_SEED_CACHE  - where to cache one (default: $XDG_CACHE_HOME/rozelynx-test)
set -u -o pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PKG="$(cd "${HERE}/../.." && pwd)"
# The default subject is the 156.0.1 branding block, whichever REVISION the
# tree names it by. The overlay once carried it as firefox-156.0.1.ebuild and
# revbumped to firefox-156.0.1-r1.ebuild - the branding block itself is
# byte-identical either way, being generated from the same template - so a
# default that named only the un-revbumped file went FATAL the day the rename
# landed, and a leg that cannot find its subject is worse than one that skips
# it loudly. Plain name first, then the newest -rN, matching what an emerge
# would actually read.
EBUILD="${RZ_EBUILD:-}"
if [ -z "${EBUILD}" ]; then
	for _c in "${PKG}"/firefox-156.0.1.ebuild "${PKG}"/firefox-156.0.1-r*.ebuild; do
		if [ -f "${_c}" ]; then
			EBUILD="${_c}"
			break
		fi
	done
fi
ROOT="${RZ_TEST_ROOT:-${PKG}/files/rozelynx}"
# The ebuild's ${FILESDIR} is files/, and the block writes ${FILESDIR}/rozelynx/...
# so it is the PARENT of the root, not the root. Getting this wrong makes every
# path in the block wrong, which the self-test below catches rather than
# reporting a pass.
FILESDIR="$(dirname "${ROOT}")"
# The block runs in a separate `bash run.sh`, so FILESDIR has to be EXPORTED.
# Unset, every ${FILESDIR}/rozelynx/... path collapses to /rozelynx/... and the
# block dies on the first cp - which is loud, at least, but it is a wasted run.
export FILESDIR
CACHE="${RZ_SEED_CACHE:-${XDG_CACHE_HOME:-${HOME}/.cache}/rozelynx-test-seed}"
# The version whose upstream branding dir seeds the tree. It has to match the
# ebuild under test, or the assertions are about a different Firefox. A
# Gentoo revision suffix (-rN) is NOT part of the version: the seed and the
# distfile are keyed by PV, and a revbump does not change the branding block,
# so the suffix is stripped rather than looked up.
SEED_PV="$(basename "${EBUILD}" | sed -n 's/^firefox-\(.*\)\.ebuild$/\1/p')"
SEED_PV="${SEED_PV%%-r*}"
DISTFILE="${RZ_DISTFILE:-/var/cache/distfiles/firefox-${SEED_PV}.source.tar.xz}"

green() { printf '\033[32m%s\033[0m\n' "$*"; }
red()   { printf '\033[31m%s\033[0m\n' "$*"; }
bold()  { printf '\033[1m%s\033[0m\n' "$*"; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

# ---------------------------------------------------------------- the seed
# The block copies the REAL upstream branding dir, so the harness needs a real
# one. xz is not seekable, so building this from the distfile streams the whole
# 800 MB - hence the cache, and hence the loud failure rather than a silent
# fallback to some other tree's files.
seed_dir() {
	if [ -n "${RZ_BRAND_SEED:-}" ] && [ -d "${RZ_BRAND_SEED}" ]; then
		printf '%s' "${RZ_BRAND_SEED}"
		return 0
	fi
	local cached="${CACHE}/firefox-${SEED_PV}/browser/branding/unofficial"
	if [ -f "${cached}/locales/en-US/brand.ftl" ]; then
		printf '%s' "${cached}"
		return 0
	fi
	if [ ! -f "${DISTFILE}" ]; then
		return 1
	fi
	# On stderr, not stdout: this function RETURNS the seed path by printing it,
	# so a progress line on stdout was captured into the caller's variable and
	# the seed path arrived with the ANSI text glued to the front of it. Same
	# class of mistake as the strip count above: the harness reported a
	# filesystem problem that was really its own plumbing.
	bold "branding: seeding from ${DISTFILE##*/} (streams the whole tarball, once)" >&2
	mkdir -p "${CACHE}/firefox-${SEED_PV}" || return 1
	# --strip-components=1, not 2: the member is
	#   firefox-156.0.1/browser/branding/unofficial/...
	# and `cached` (above) is ${CACHE}/firefox-156.0.1/browser/branding/
	# unofficial, so exactly one component - the version directory - has to go.
	# Stripping two landed the tree at .../branding/unofficial, the brand.ftl
	# probe below then missed, and the leg reported "no upstream branding dir"
	# while naming the distfile it was standing on - a harness pointing at the
	# wrong cause, which is the failure mode this one was written to avoid.
	if ! tar -xJf "${DISTFILE}" -C "${CACHE}/firefox-${SEED_PV}" \
		--strip-components=1 "firefox-${SEED_PV}/browser/branding/unofficial" \
		2>/dev/null; then
		rm -rf "${CACHE}/firefox-${SEED_PV}"
		return 1
	fi
	if [ ! -f "${cached}/locales/en-US/brand.ftl" ]; then
		rm -rf "${CACHE}/firefox-${SEED_PV}"
		return 1
	fi
	printf '%s' "${cached}"
}

bold "== branding =="
if [ ! -f "${EBUILD}" ]; then
	red "   FATAL: no ebuild at ${EBUILD}"
	exit 2
fi
printf '   ebuild    %s\n' "${EBUILD}"
printf '   subject   %s\n' "$(sha256sum "${EBUILD}" | cut -c1-16)"
printf '   files     %s\n' "${FILESDIR}"

# A seed that names a DIFFERENT Firefox than the ebuild under test would make
# every assertion a statement about the wrong tree. The two 156 ebuilds share a
# byte-identical branding dir so this is harmless today, which is exactly why it
# has to be checked rather than assumed.
check_seed_version() {
	local seed_path="$1"
	local named
	named="$(printf '%s' "${seed_path}" | sed -n 's|.*/\(firefox-[0-9][^/]*\)/.*|\1|p' | head -1)"
	[ -n "${named}" ] || return 0                       # nothing to compare
	[ "${named}" = "firefox-${SEED_PV}" ] && return 0
	if [ "${RZ_BRAND_SEED_FORCE:-0}" = "1" ]; then
		printf '   WARNING: seed names %s, ebuild is firefox-%s; continuing because\n' \
			"${named}" "${SEED_PV}"
		printf '            RZ_BRAND_SEED_FORCE=1 was set.\n'
		return 0
	fi
	red "   FATAL: the seed names ${named} but the ebuild under test is firefox-${SEED_PV}."
	red "   These have byte-identical branding dirs today, so this is very"
	red "   likely benign - but 'very likely benign' is how the previous"
	red "   version of this harness came to test a stale ebuild."
	red "   Set RZ_BRAND_SEED_FORCE=1 to proceed anyway."
	return 1
}

SEED="$(seed_dir)" || {
	red "   FATAL: no upstream branding dir for firefox-${SEED_PV}."
	red "   Need one of:"
	red "     RZ_BRAND_SEED=<dir>   a pre-extracted browser/branding/unofficial"
	red "     ${DISTFILE}           to build the cache from"
	red "   Refusing to substitute another version's files: the assertions are"
	red "   about this ebuild's slots in this Firefox's tree."
	exit 2
}
check_seed_version "${SEED}" || exit 2
printf '   seed      %s\n' "${SEED}"

# ------------------------------------------------------- the poisoned tree
S="${WORK}/src"
mkdir -p "${S}/browser/branding"
cp -a "${SEED}" "${S}/browser/branding/unofficial"
B="${S}/browser/branding/unofficial"
[ -f "${B}/locales/en-US/brand.ftl" ] || { red "   FATAL: seed has no brand.ftl"; exit 2; }

POISON='RED-STAND-IN'
poison() { printf '%s' "${POISON}" > "$1"; }

# The branding dir's own slots.
for f in about.png about-logo.png about-logo@2x.png about-logo-private.png \
         about-logo-private@2x.png about-logo.svg about-wordmark.svg \
         firefox-wordmark.svg default.svg; do
	poison "${B}/content/${f}"
done
poison "${B}/about.png"
for n in 16 22 24 32 48 64 128 256; do poison "${B}/default${n}.png"; done

# The trees the block writes outside the branding dir. Every path the
# block's [[ -e ]] || die pre-flight lists, every path its cat >/cp's land
# in, and both activity-stream sheets must exist here first: a missing
# path dies the block mid-run instead of skipping the write, and the
# die is the correct behaviour - the harness tree, not the ebuild, is
# what is incomplete. The 156.0.1 additions are the private newtab wiring
# (themes/shared/privatebrowsing/ and identity-block/, the shared-skin
# allowlist jar.inc.mn, the private page's own stylesheet) and the two
# activity-stream sheets the newtab logo rules rewrite.
mkdir -p "${S}/browser/themes/shared/addons" \
         "${S}/browser/themes/shared/fxa" \
         "${S}/browser/themes/shared/privatebrowsing" \
         "${S}/browser/themes/shared/identity-block" \
         "${S}/toolkit/themes/shared/icons" \
         "${S}/toolkit/themes/shared/extensions" \
         "${S}/browser/themes/shared/icons" \
         "${S}/toolkit/components/satchel/megalist/content/icons" \
         "${S}/browser/components/profiles/content/assets" \
         "${S}/browser/extensions/newtab/css/nova"
poison "${S}/toolkit/themes/shared/icons/defaultFavicon.svg"
poison "${S}/browser/themes/shared/icons/window-firefox.svg"
poison "${S}/browser/themes/shared/addons/extensions-panel-empty.svg"
poison "${S}/browser/themes/shared/addons/extensions-panel-empty-onboarding.svg"
poison "${S}/browser/themes/shared/fxa/avatar-fox.svg"
poison "${S}/browser/themes/shared/fxa/avatar-fox-circle.svg"
poison "${S}/browser/themes/shared/identity-block/trustpanel-graphic-enabled.svg"
poison "${S}/browser/themes/shared/identity-block/trustpanel-graphic-warning.svg"
poison "${S}/browser/themes/shared/identity-block/trustpanel-graphic-disabled.svg"
poison "${S}/toolkit/components/satchel/megalist/content/icons/cpm-fox-illustration.svg"
poison "${S}/toolkit/themes/shared/extensions/category-extensions.svg"
poison "${S}/browser/components/profiles/content/assets/plus.svg"
# The private newtab wiring. Poisoned, not stubbed with upstream content:
# the block only APPENDS to the sheets and the allowlist (and cp's over the
# two favicon slots), so "my line landed in the file" is the assertion.
poison "${S}/browser/themes/shared/privatebrowsing/aboutPrivateBrowsing.css"
poison "${S}/browser/themes/shared/privatebrowsing/favicon.svg"
poison "${S}/browser/themes/shared/identity-block/privateNewtabFavicon.svg"
poison "${S}/browser/themes/shared/jar.inc.mn"
poison "${S}/browser/extensions/newtab/css/activity-stream.css"
poison "${S}/browser/extensions/newtab/css/nova/activity-stream.css"

# ------------------------------------------------------- extract and run
if ! python3 "${HERE}/extract-block.py" "${EBUILD}" "${WORK}/block.sh" --quiet; then
	red "   FATAL: could not extract the branding block (see above)"
	exit 2
fi
green "   extracted the block by content, not by line range"

{
	cat <<'STUB'
use() { case " $* " in *" rozelynx "*) return 0;; *) return 1;; esac; }
einfo() { echo "einfo: $*"; }
ewarn() { echo "ewarn: $*"; }
die() { echo "DIE: $*" >&2; exit 1; }
eapply() { :; }
STUB
	echo "_rozelynx_branding() {"
	cat "${WORK}/block.sh"
	echo "}"
	echo "_rozelynx_branding"
} > "${WORK}/run.sh"

cd "${S}" || exit 2
# Self-test the one pipeline the vector helper depends on, in this cwd and with
# this PATH. If magick cannot do this, every later failure is a false negative.
if ! _self=$(magick "${FILESDIR}/rozelynx/branding/main/no-text.png" \
		-resize "192x512" -background none -gravity center \
		-extent 512x512 -strip png:- | base64 -w0) || [ -z "${_self}" ]; then
	red "   FATAL: the helper's own pipeline produced nothing here."
	red "   magick on PATH: $(command -v magick || echo MISSING)"
	exit 2
fi
printf '   self-test %s bytes from the embed pipeline\n' "${#_self}"

bash "${WORK}/run.sh" > "${WORK}/out.log" 2>&1
rc=$?

# A block that never ran is the failure mode that reads as a pass, so the
# block's own einfo is the liveness check.
if ! grep -q 'Generating RozeLynx branding icons' "${WORK}/out.log"; then
	red "   FATAL: the branding block never ran - refusing to report a pass."
	sed -n '1,25p' "${WORK}/out.log" | sed 's/^/      | /'
	exit 2
fi
if [ "${rc}" -ne 0 ]; then
	red "   the block exited ${rc}"
	grep -E '^(einfo|ewarn|DIE)' "${WORK}/out.log" | sed 's/^/      | /'
fi

R="${S}/browser/branding/rozelynx"
bad=0
is_poisoned() { [ -f "$1" ] && head -c "${#POISON}" "$1" 2>/dev/null | grep -q "${POISON}"; }
written() {
	if [ ! -f "$1" ]; then
		printf '  %-56s MISSING\n' "$2"; return 1
	fi
	if is_poisoned "$1"; then
		printf '  %-56s NOT WRITTEN (stand-in survives)\n' "$2"; return 1
	fi
	printf '  %-56s written (%s B)\n' "$2" "$(wc -c <"$1")"; return 0
}

echo
echo "-- the five sizes jar.mn installs --"
for n in 16 32 48 64 128; do
	written "${R}/default${n}.png" "default${n}.png" || bad=1
done
# The 64px slot has its OWN source: branding/favicon64.png, not the line art
# the other four sizes share (it is the window/taskbar icon, the one size a user
# actually sees). "default64.png was written" is not that assertion - it passes
# just as happily when the slot is derived from dark/no-text.png like all the
# others, which is exactly the state this check exists to distinguish. So
# regenerate the icon both ways and compare bytes.
#
# Comparing against the real magick output rather than a recorded hash: the
# point is which SOURCE was used, and re-deriving it from the same sources is
# what makes that answerable without pinning an encoder's fingerprint.
#
# "The same sources" has to mean the same PIPELINE, -background none included.
# Without it this re-derivation produces an opaque render, compares it against a
# transparent slot, and reports a mismatch on a perfectly correct build - which
# is what it did until the ebuild's guard was mirrored here.
for variant in favicon64 dark; do
	case "${variant}" in
		favicon64) src_icon="${FILESDIR}/rozelynx/branding/favicon64.png" ;;
		dark)      src_icon="${FILESDIR}/rozelynx/branding/dark/no-text.png" ;;
	esac
	exp="${WORK}/expect-${variant}-64.png"
	if ! magick "${src_icon}" -background none -resize "64x64^" -gravity center -extent "64x64" "${exp}" 2>/dev/null; then
		printf '  64px source check SKIPPED (magick could not render %s)\n' "${variant}"
		continue
	fi
	# Raw pixels, not bytes. `cmp` on the PNGs is wrong even when the render is
	# right: two magick runs over identical input come out the same length and
	# still differ byte-for-byte, because the encoder stamps its own metadata.
	# Decoding to a flat RGBA stream compares what is actually on screen.
	if magick "${exp}" -depth 8 rgba:- 2>/dev/null | cmp -s - \
	     <(magick "${R}/default64.png" -depth 8 rgba:- 2>/dev/null); then
		printf '  default64.png derived from %-12s (as intended)\n' "${variant}"
		if [ "${variant}" != favicon64 ]; then
			printf '  default64.png derived from dark/no-text.png - the favicon64 artwork is NOT wired in\n'
			bad=1
		fi
	else
		printf '  default64.png does not match the %s render\n' "${variant}"
	fi
done

echo "-- the three sizes jar.mn does not install (must be left alone) --"
for n in 22 24 256; do
	if [ ! -f "${R}/default${n}.png" ]; then
		printf '  default%-4s absent\n' "${n}.png"
	elif is_poisoned "${R}/default${n}.png"; then
		printf '  default%-4s untouched, as intended\n' "${n}.png"
	else
		printf '  default%-4s REWRITTEN - still generating a size nothing installs\n' "${n}.png"
		bad=1
	fi
done
# The launcher ladder. Its own artwork (branding/launcher-square.png), its own name
# (rozelynx-launcher), because rozelynx.png is also the notification-badge icon
# and the badge is wanted as the logo. "written" is the weak half; the source
# check below is the one that matters, for the same reason the 64px check
# re-derives its icon. The source is branding/launcher-square.png (475x475, 1:1),
# so every size in the ladder is a plain downscale and nothing is cropped.
echo "-- the launcher ladder --"
for n in 16 24 32 48 64 128 256 512; do
	written "${R}/launcher${n}.png" "launcher${n}.png" || bad=1
done
if [[ -f "${FILESDIR}/rozelynx/branding/launcher-square.png" ]] && command -v magick >/dev/null 2>&1; then
	for n in 48 256; do
		exp="${WORK}/expect-launcher-${n}.png"
		magick "${FILESDIR}/rozelynx/branding/launcher-square.png" -background none \
			-resize "${n}x${n}^" -gravity center -extent "${n}x${n}" "${exp}" 2>/dev/null || continue
		if magick "${exp}" -depth 8 rgba:- 2>/dev/null | cmp -s - \
		     <(magick "${R}/launcher${n}.png" -depth 8 rgba:- 2>/dev/null); then
			printf '  launcher%-4s derived from launcher-square.png (as intended)\n' "${n}.png"
		else
			printf '  launcher%-4s does not match the launcher-square.png render\n' "${n}.png"
			bad=1
		fi
	done
fi

# The fallback favicon. A raster embedded in the slot's SVG, so the assertion is
# that the embedded payload IS branding/favicon64.png - a well-formed SVG with a
# truncated or stale data URI would still parse, and would still be "written".
echo "-- the fallback favicon --"
_fav="${S}/toolkit/themes/shared/icons/defaultFavicon.svg"
written "${_fav}" "toolkit/themes/shared/icons/defaultFavicon.svg" || bad=1
if [[ -f "${_fav}" ]] && [[ -f "${FILESDIR}/rozelynx/branding/favicon64.png" ]]; then
	_got="$(sed -n 's/.*base64,\([A-Za-z0-9+/=]*\)".*/\1/p' "${_fav}" | head -1 | base64 -d 2>/dev/null | sha256sum | cut -d' ' -f1)"
	_want="$(sha256sum < "${FILESDIR}/rozelynx/branding/favicon64.png" | cut -d' ' -f1)"
	if [[ -n "${_got}" && "${_got}" = "${_want}" ]]; then
		printf '  %-56s embeds favicon64.png\n' "defaultFavicon.svg payload"
	else
		printf '  %-56s NOT favicon64.png (got %s)\n' "defaultFavicon.svg payload" "${_got:-nothing}"
		bad=1
	fi
	# Both pref-gated variants must be present, or the nova UI falls back to
	# stock artwork - which is the failure the stock file's own <style> guards.
	_nova="$(grep -c 'class="nova"' "${_fav}" || true)"
	if [[ "${_nova}" -ge 1 ]]; then
		printf '  %-56s keeps the nova variant\n' "defaultFavicon.svg"
	else
		printf '  %-56s nova variant MISSING - nova UI shows stock art\n' "defaultFavicon.svg"
		bad=1
	fi
fi

# Transparency must SURVIVE the resize. This is the check for a bug that had
# been shipping: -extent composites onto the background colour, so without
# -background none it throws the alpha channel away. The resize keeps it and
# the extent flattens it, and the result looks like correct artwork - so
# nothing that only asks "was this slot written" could ever notice.
#
# Measured on branding/dark/no-text.png, which is line art at 24% mean alpha:
# the window icons were coming out fully opaque, i.e. a solid square behind the
# mark. The launcher ladder (87%) was losing the same way. The rule, so it
# holds for whatever art arrives next: if the SOURCE is not fully opaque, the
# generated slot must not be either.
echo "-- alpha survives the resize --"
alpha_of() { magick "$1" -alpha extract -format '%[fx:mean]' info: 2>/dev/null; }
check_alpha() {
	local src="$1" out="$2" label="$3"
	[[ -f "${src}" && -f "${out}" ]] || return 0
	command -v magick >/dev/null 2>&1 || return 0
	local sa oa
	sa="$(alpha_of "${src}")"; oa="$(alpha_of "${out}")"
	[[ -n "${sa}" && -n "${oa}" ]] || return 0
	# Only meaningful when the source actually has transparency to lose.
	awk -v a="${sa}" 'BEGIN{exit !(a < 0.999)}' || return 0
	if awk -v a="${oa}" 'BEGIN{exit !(a < 0.999)}'; then
		printf '  %-30s keeps transparency (source %.2f -> slot %.2f)\n' "${label}" "${sa}" "${oa}"
	else
		printf '  %-30s OPAQUE - the extent flattened it (source %.2f -> slot %.2f)\n' "${label}" "${sa}" "${oa}"
		bad=1
	fi
}
check_alpha "${FILESDIR}/rozelynx/branding/dark/no-text.png" "${R}/default64.png" "default64.png"
check_alpha "${FILESDIR}/rozelynx/branding/dark/no-text.png" "${R}/default128.png" "default128.png"
check_alpha "${FILESDIR}/rozelynx/branding/private-browsing.png" \
	"${R}/content/about-logo-private.png" "about-logo-private.png"
check_alpha "${FILESDIR}/rozelynx/branding/launcher-square.png" "${R}/launcher256.png" "launcher256.png"
check_alpha "${FILESDIR}/rozelynx/branding/launcher-square.png" "${R}/launcher48.png" "launcher48.png"

# The shipped page wallpapers. The block cp's committed art in verbatim
#   content/newtab-background.png  <- branding/newtab-background.png
#   content/private-wallpaper.png <- branding/private-background.png
#      (the marketing pounce-thorns.jpg, converted to a -strip PNG)
# so byte-equality with the source is the strong assertion -- "written"
# alone would pass on any file the block produced. Both must also be
# registered in content/jar.mn: that file is an ALLOWLIST, and a slot
# missing from it is silently dropped from browser.jar -- the chrome://
# URL then 404s at runtime while the CSS referencing it looks perfectly
# correct, which is exactly how both wallpapers once failed to appear.
echo "-- the shipped page wallpapers --"
for w in newtab-background.png private-wallpaper.png; do
	case "${w}" in
		newtab-background.png)  wsrc="newtab-background.png" ;;
		private-wallpaper.png) wsrc="private-background.png" ;;
	esac
	if [ ! -f "${FILESDIR}/rozelynx/branding/${wsrc}" ]; then
		printf '  %-40s source branding/%s absent\n' "content/${w}" "${wsrc}"
		continue
	fi
	written "${R}/content/${w}" "content/${w}" || bad=1
	if [ -f "${R}/content/${w}" ] && cmp -s "${R}/content/${w}" "${FILESDIR}/rozelynx/branding/${wsrc}"; then
		printf '  %-40s byte-equal to branding/%s\n' "content/${w}" "${wsrc}"
	else
		printf '  %-40s is NOT the committed branding/%s\n' "content/${w}" "${wsrc}"; bad=1
	fi
	if grep -q "content/branding/${w}\$" "${R}/content/jar.mn" 2>/dev/null; then
		printf '  %-40s registered in content/jar.mn\n' "${w}"
	else
		printf '  %-40s NOT in content/jar.mn - its URL will 404\n' "${w}"; bad=1
	fi
done
# The private page's own stylesheet gains the body rule. The block
# APPENDS to aboutPrivateBrowsing.css, so the assertion is the URL
# landing in the file -- a rule pointing at an unregistered slot looks
# correct and paints nothing.
_pcss="${S}/browser/themes/shared/privatebrowsing/aboutPrivateBrowsing.css"
if grep -q 'url("chrome://branding/content/private-wallpaper.png")' "${_pcss}" 2>/dev/null; then
	printf '  %-40s carries the private-wallpaper body rule\n' "aboutPrivateBrowsing.css"
else
	printf '  %-40s MISSING the private-wallpaper body rule\n' "aboutPrivateBrowsing.css"; bad=1
fi
# The viewing angle. The pounce scene's subject sits mid-frame, and cover
# on a wide window crops vertically, so the crop must be CENTRED -- the
# top-left anchor inherited from the cat art framed the upper part of the
# scene and cut the subject out of view. Both declarations that decide the
# angle are pinned here, so the anchor cannot quietly drift back to the
# 0% 0% the non-private newtab uses.
if grep -q 'background-position: center;' "${_pcss}" 2>/dev/null; then
	printf '  %-40s centres the crop (subject stays in view)\n' "aboutPrivateBrowsing.css"
else
	printf '  %-40s the wallpaper crop is not centred\n' "aboutPrivateBrowsing.css"; bad=1
fi
if grep -q 'background-size: cover;' "${_pcss}" 2>/dev/null; then
	printf '  %-40s cover: scale to fit, crop the overflow\n' "aboutPrivateBrowsing.css"
else
	printf '  %-40s the wallpaper is not cover-scaled\n' "aboutPrivateBrowsing.css"; bad=1
fi
echo "-- the branding dir's own slots --"
for f in content/about.png content/about-logo.png content/about-logo@2x.png \
         about.png content/about-logo-private.png content/about-logo-private@2x.png \
         content/about-logo.svg content/about-wordmark.svg content/firefox-wordmark.svg \
         default.svg; do
	written "${R}/${f}" "rozelynx/${f}" || bad=1
done
echo "-- the slots outside the branding dir --"
for p in browser/themes/shared/addons/extensions-panel-empty.svg \
         browser/themes/shared/addons/extensions-panel-empty-onboarding.svg \
         toolkit/components/satchel/megalist/content/icons/cpm-fox-illustration.svg \
         browser/components/profiles/content/assets/plus.svg \
         toolkit/themes/shared/extensions/category-extensions.svg \
         browser/themes/shared/privatebrowsing/favicon.svg \
         browser/themes/shared/identity-block/privateNewtabFavicon.svg; do
	written "${S}/${p}" "${p}" || bad=1
done
# Both favicon slots must be the committed claw, byte-for-byte -- they
# are plain cp's -- and the identity-block copy must be registered in
# jar.inc.mn, the themes/shared allowlist, or it is silently dropped.
if [ -f "${S}/browser/themes/shared/privatebrowsing/favicon.svg" ] && \
   cmp -s "${S}/browser/themes/shared/privatebrowsing/favicon.svg" \
      "${FILESDIR}/rozelynx/branding/privateNewtabFavicon.svg"; then
	printf '  %-56s is the committed claw SVG\n' "privatebrowsing/favicon.svg"
else
	printf '  %-56s is NOT branding/privateNewtabFavicon.svg\n' "privatebrowsing/favicon.svg"; bad=1
fi
if grep -q 'identity-block/privateNewtabFavicon.svg' "${S}/browser/themes/shared/jar.inc.mn" 2>/dev/null; then
	printf '  %-56s registered in shared jar.inc.mn\n' "identity-block/privateNewtabFavicon.svg"
else
	printf '  %-56s NOT in shared jar.inc.mn - silently dropped\n' "identity-block/privateNewtabFavicon.svg"; bad=1
fi

# The about:addons sidebar icon and the private-browsing logo both have their
# own artwork now, and both are slots that existed before with different art.
# "Written" is the weak half, as with every other slot here: it is equally true
# of the stock icon. So the source is re-derived and compared as decoded pixels,
# through the same pipeline the ebuild uses.
# Two shapes of slot, so two comparisons. A PNG slot can be compared to the
# render directly. An SVG slot carries the raster as a base64 <image> at a
# 2x budget inside a smaller user-unit canvas, so comparing the FILE to a render
# can never match - the payload has to be decoded out first. Getting that
# backwards is the whole of the first version of this check, which reported the
# slot as wrong on a correct build.
check_png_slot() {
	local src="$1" out="$2" label="$3" ew="$4" eh="$5"
	[[ -f "${src}" && -f "${out}" ]] || return 0
	command -v magick >/dev/null 2>&1 || return 0
	local exp="${WORK}/expect-${label%.svg}-${ew}x${eh}.png"
	# shellcheck disable=SC2086  # ew/eh are numbers on purpose
	magick "${src}" -background none -resize "${ew}x${eh}^" -gravity center \
		-extent "${ew}x${eh}" "${exp}" 2>/dev/null || return 0
	if magick "${exp}" -depth 8 rgba:- 2>/dev/null | cmp -s - \
	     <(magick "${out}" -depth 8 rgba:- 2>/dev/null); then
		printf '  %-30s derived from its own artwork (as intended)\n' "${label}"
	else
		printf '  %-30s does not match the render of its source\n' "${label}"
		bad=1
	fi
}

# $4/$5 are the CANVAS the SVG declares; $6/$7 the EMBED size of the raster
# inside it. Both are asserted, because getting them backwards is exactly the
# bug this function exists to catch. The render uses CONTAIN (-resize, no "^")
# to match rozelynx_install_vector_slot, not the crop the raster slots use.
check_svg_slot() {
	local src="$1" out="$2" label="$3" cw="$4" ch="$5" ew="$6" eh="$7"
	[[ -f "${src}" && -f "${out}" ]] || return 0
	command -v magick >/dev/null 2>&1 || return 0
	if ! grep -q "viewBox=\"0 0 ${cw} ${ch}\"" "${out}"; then
		printf '  %-30s does not declare a %sx%s canvas\n' "${label}" "${cw}" "${ch}"
		bad=1
		return 0
	fi
	# The temp names deliberately end in .png and not in the slot's name: magick
	# chooses its output format from the extension, so a PNG written to
	# "expect-category-extensions.svg" is an SVG, and reading one back is
	# refused by magick's own SVG security policy. That made a byte-identical
	# payload compare unequal.
	local b64 exp="${WORK}/expect-${label%.svg}-${cw}x${ch}.png"
	b64="$(sed -n 's/.*base64,\([A-Za-z0-9+/=]*\)".*/\1/p' "${out}" | head -1)"
	if [[ -z "${b64}" ]]; then
		printf '  %-30s carries no embedded raster\n' "${label}"
		bad=1
		return 0
	fi
	printf '%s' "${b64}" | base64 -d > "${exp%.png}-payload.png" 2>/dev/null
	# shellcheck disable=SC2086  # ew/eh are numbers on purpose
	magick "${src}" -background none -resize "${ew}x${eh}" -gravity center \
		-extent "${ew}x${eh}" "${exp}" 2>/dev/null || return 0
	if magick "${exp}" -depth 8 rgba:- 2>/dev/null | cmp -s - \
	     <(magick "${exp%.png}-payload.png" -depth 8 rgba:- 2>/dev/null); then
		printf '  %-30s embeds its own artwork (as intended)\n' "${label}"
	else
		printf '  %-30s payload is not the render of its source\n' "${label}"
		bad=1
	fi
}

check_svg_slot "${FILESDIR}/rozelynx/branding/about-addons-category.png" \
	"${S}/toolkit/themes/shared/extensions/category-extensions.svg" \
	"category-extensions.svg" 20 20 60 60
check_png_slot "${FILESDIR}/rozelynx/branding/private-browsing.png" \
	"${R}/content/about-logo-private.png" "about-logo-private.png" 192 192
echo "-- deliberately NOT branded --"
if is_poisoned "${S}/browser/themes/shared/icons/window-firefox.svg"; then
	echo "  window-firefox.svg left as Fox art, as documented"
else
	echo "  window-firefox.svg was rewritten"; bad=1
fi

echo
if [ "${bad}" -eq 0 ] && [ "${rc}" -eq 0 ]; then
	green "branding: all slots written, all deliberate omissions held"
	exit 0
fi
red "branding: ${bad} assertion(s) failed (block exit ${rc})"
exit 1
