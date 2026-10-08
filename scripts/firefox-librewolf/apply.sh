#!/bin/bash
# Post-sync hook for www-client/firefox in the ByteWheel overlay.
# Restores the LibreWolf hardening AND the RozeLynx customization after
# the upstream sync rsyncs vanilla firefox ebuilds from the Gentoo repo
# (the rsync --delete wipes any files upstream does not ship).
#
# Called by the upstream sync as:
#   apply.sh <pkg_dir> <overlay_root>
#
# The UPSTREAM file must contain:
#   post-sync: scripts/firefox-librewolf/apply.sh
#
# Backups kept in scripts/firefox-librewolf/ (survives the rsync):
#   firefox-template.ebuild          full RozeLynx+LibreWolf ebuild template
#   librewolf files (top level)      restored to files/librewolf/
#   ui-patches/                      restored to files/librewolf/ui-patches/
#   rozelynx/                        restored to files/rozelynx/
#   root-patches/                    restored to files/ (top level patches)
#   plans/                           pkg-dir *.md docs, restored to pkg dir
#   metadata-full.xml                full custom metadata.xml (restored when the
#                                     synced vanilla metadata lacks rozelynx)
#   metadata-rozelynx-flags.xml      merged into metadata.xml if missing

set -e

pkg_dir="${1:?}"
target_path="${2:?}"
backup_dir="$target_path/scripts/firefox-librewolf"
template="$backup_dir/firefox-template.ebuild"
firefox_files="$pkg_dir/files"

patched_marker='RozeLynx Web Browser|with LibreWolf-style privacy hardening'

echo "  -> Restoring LibreWolf patches..."
rm -rf "$firefox_files/librewolf"
mkdir -p "$firefox_files/librewolf"

find "$backup_dir" -maxdepth 1 -type f \
    ! -name apply.sh \
    ! -name firefox-template.ebuild \
    ! -name metadata-rozelynx-flags.xml \
    ! -name metadata-full.xml \
    ! -name Manifest \
    -exec cp -a {} "$firefox_files/librewolf/" \;

if [[ -d "$backup_dir/ui-patches" ]]; then
    cp -a "$backup_dir/ui-patches" "$firefox_files/librewolf/"
fi

echo "  -> Restoring RozeLynx files..."
rm -rf "$firefox_files/rozelynx"
mkdir -p "$firefox_files/rozelynx"
if [[ -d "$backup_dir/rozelynx" ]]; then
    cp -a "$backup_dir/rozelynx/." "$firefox_files/rozelynx/"
fi
if [[ -d "$backup_dir/root-patches" ]]; then
    cp -a "$backup_dir/root-patches/." "$firefox_files/"
fi

echo "  -> Restoring plan documents..."
# The rsync --delete wipes the pkg dir except UPSTREAM; plan/session docs
# (PLAN-*.md etc.) are backed up in plans/ and restored here.
if [[ -d "$backup_dir/plans" ]]; then
    cp -a "$backup_dir/plans/." "$pkg_dir/"
fi

echo "  -> Restoring RozeLynx USE flag metadata..."
# The synced vanilla metadata.xml lacks all rozelynx flags and custom
# descriptions; restore the full custom file when the fragment is absent.
if [[ -f "$pkg_dir/metadata.xml" ]] \
    && ! grep -q 'name="rozelynx"' "$pkg_dir/metadata.xml" 2>/dev/null \
    && [[ -f "$backup_dir/metadata-full.xml" ]]; then
    cp -a "$backup_dir/metadata-full.xml" "$pkg_dir/metadata.xml"
    echo "     restored full custom metadata.xml from backup"
fi
if [[ -f "$backup_dir/metadata-rozelynx-flags.xml" ]]; then
    python3 - "$pkg_dir/metadata.xml" "$backup_dir/metadata-rozelynx-flags.xml" <<'PYEOF'
import sys
meta, frag = sys.argv[1], sys.argv[2]
with open(frag) as f:
    block = f.read().rstrip("\n")
with open(meta) as f:
    text = f.read()
if 'name="rozelynx"' in text:
    sys.exit(0)
if "</use>" in text:
    text = text.replace("</use>", block + "\n</use>", 1)
else:
    text = text.replace(
        "</pkgmetadata>", "  <use>\n" + block + "\n  </use>\n</pkgmetadata>", 1
    )
with open(meta, "w") as f:
    f.write(text)
PYEOF
fi

echo "  -> Checking for new firefox versions..."

# Variables that are version-sensitive upstream and must be re-synced from
# the freshly synced vanilla ebuild into the regenerated patched ebuild.
version_vars=(
    FIREFOX_PATCHSET
    LLVM_COMPAT
    RUST_MIN_VER
    PYTHON_COMPAT
    WASI_SDK_VER
    WASI_SDK_LLVM_VER
    MOZ_ESR
)

# Also scan the master (gentoo) repo for new versions not yet in the overlay.
gentoo_pkg_dir=""
if [[ -d "/var/db/repos/gentoo/www-client/firefox" ]]; then
    gentoo_pkg_dir="/var/db/repos/gentoo/www-client/firefox"
elif command -v portageq >/dev/null 2>&1; then
    _grepo=$(portageq repos_config / 2>/dev/null | awk '/\[gentoo\]/{found=1; next} /\[/{found=0} found && /location/{print $3; exit}')
    [[ -n "$_grepo" ]] && gentoo_pkg_dir="$_grepo/www-client/firefox"
fi

any_created=0

# Collect ebuilds: overlay first, then any new ones from the gentoo master repo.
_versions_seen=()
for _src_dir in "$pkg_dir" "$gentoo_pkg_dir"; do
    [[ -d "$_src_dir" ]] || continue
    for ebuild in "$_src_dir"/firefox-*.ebuild; do
        [[ -f "$ebuild" ]] || continue
        ver=$(basename "$ebuild" .ebuild)
        ver=${ver#firefox-}
        # Skip if we already processed this version.
        for _v in "${_versions_seen[@]}"; do
            [[ "$_v" == "$ver" ]] && continue 2
        done
        _versions_seen+=("$ver")

        target="$pkg_dir/firefox-${ver}.ebuild"
        [[ -f "$target" ]] && grep -qE "$patched_marker" "$target" 2>/dev/null && continue

        if [[ "$ver" =~ ^[0-9]+\. && "$ver" < "150.0" ]]; then
            continue
        fi
        if grep -qE '^MOZ_ESR=yes' "$ebuild" 2>/dev/null; then
            echo "  -> Leaving firefox-${ver}.ebuild vanilla (ESR branch)"
            continue
        fi

        # Copy vanilla ebuild from gentoo into overlay if not present.
        [[ -f "$target" ]] || cp -a "$ebuild" "$target"
        echo "  -> Creating patched firefox-${ver}.ebuild from template..."

        var_lines=()
        for var in "${version_vars[@]}"; do
            val=$(grep -m1 "^${var}=" "$target" 2>/dev/null | head -1)
            [[ -n "$val" ]] && var_lines+=("${var}|${val}")
        done

        cp "$template" "$target"
        for entry in "${var_lines[@]}"; do
            var="${entry%%|*}"
            val="${entry#*|}"
            sed -i "s|^${var}=.*|${val}|" "$target"
        done
        any_created=1
    done
done

if [[ $any_created -eq 0 ]]; then
    echo "  -> All firefox versions are up to date."
fi

newest_patched=$(ls -v "$pkg_dir"/firefox-*.ebuild 2>/dev/null | while read -r e; do
    if grep -qE "$patched_marker" "$e" 2>/dev/null; then
        basename "$e"
    fi
done | tail -n 1)

if [[ -n "$newest_patched" ]]; then
    cp -f "$pkg_dir/$newest_patched" "$template"
    echo "  -> Updated template to $newest_patched"
fi

echo "  -> Regenerating manifest..."
(
    cd "$pkg_dir" || exit 1
    ebuild_file=$(ls *.ebuild 2>/dev/null | head -n 1)
    if [[ -n "$ebuild_file" ]]; then
        ebuild "$ebuild_file" manifest > /dev/null 2>&1
    fi
)

echo "  -> Firefox hook complete."
