*For my wife, my inspiration. [YAMS](https://buymeacoffee.com/burningserenity)*

# ByteWheel Gentoo overlay

Custom Gentoo overlay for ByteWheel projects. It carries one package:
`www-client/firefox` — RozeLynx, a Firefox fork with Floorp-derived
features and LibreWolf-style privacy hardening, built through a patched
`www-client/firefox` ebuild.

- This overlay (the patched ebuild, its patch tree and the dev plumbing
  around it): https://github.com/ByteWheel/gentoo-overlay
- The RozeLynx browser repository (the published patch-tree mirror and
  the distro-agnostic build): https://github.com/ByteWheel/RozeLynx

## Installing this overlay

```sh
# with app-eselect/eselect-repository:
eselect repository add bytewheel git https://github.com/ByteWheel/gentoo-overlay.git
emerge --sync bytewheel
```

or by hand — clone it and add a repos.conf entry:

```sh
git clone https://github.com/ByteWheel/gentoo-overlay.git /var/db/repos/bytewheel
```

```ini
# /etc/portage/repos.conf/bytewheel.conf
[bytewheel]
location = /var/db/repos/bytewheel
masters = gentoo
auto-sync = no
```

## RozeLynx

# CAUTION

Please do not use this browser in sensitive operations without being aware of the risks!

This software is provided as-is, without any warranty as expressed or implied.


Firefox fork, including Librewolf and Floorp patches, plus more.

Lynxes are stronger and more dangerous than foxes. RozeLynx is beautiful, but she must be treated with care.

RozeLynx adds enhanced PWA support, modern download handoff support (well, sort of. Tested with uGet. Testers/PRs welcome!), and the pièce de résistance, per-tab network interface binding. No more redoing VPN split tunnel clients. You can set profile defaults for interfaces, and switch interface per tab on the fly. PLEASE BE CAREFUL. We made great pains preventing leaks, using DNS over HTTPS (DoH), but it is advised to treat this as alpha-stage software. We recommend users to run leak checks with tcpdump or Wireshark, before doing anything sensitive.

Linux only, for now. PRs welcome.

## Build instructions

There are two supported ways to build RozeLynx: the original Gentoo
ebuild in this overlay, and the distro-agnostic build script that works
on any Linux distribution and can package the result as a tarball,
AppImage, Flatpak or snap.

### Requirements

Both builds need the usual Firefox toolchain: a C/C++ compiler (clang is
the default), Rust (the ebuild pins a minimum version, e.g. >= 1.90),
Python 3, Node.js, NASM on x86, and the usual system libraries
(nss/nspr/icu/harfbuzz/libevent/...). The RozeLynx branding is
generated at build time with **ImageMagick 7** (`magick`) - this is a
hard requirement, not optional: the build refuses to produce an
unbranded Firefox. Expect roughly 10-19 GB of disk and several hours
of compile time.

### Gentoo (the ebuild)

RozeLynx is built on Gentoo through the patched `www-client/firefox`
ebuild in this overlay:

```sh
emerge --ask www-client/firefox
```

Features are controlled with USE flags (see the package's `metadata.xml`
for the full list). The RozeLynx set:

```
rozelynx chrome-web-store experiments external-browser i18n
mouse-gestures qr-code pwa lepton-skin ip-protection net-iface
download-handoff
```

plus the LibreWolf-style privacy hardening set (`remove-safebrowsing`,
`remove-pocket`, `remove-password-manager`, `librewolf-ui`,
`extension-firewall`, `webgl-permission`, `fingerprint-fixes`,
`privacy-ui`, `permission-tweaks`, `ui-tweaks`, `xdg-profile`, and
friends). The RozeLynx Features extension is force-installed through
policies.json, system preferences live in
`/usr/lib64/rozelynx/browser/defaults/preferences/`, and the net-iface
feature gets `CAP_NET_RAW` on `/usr/lib64/rozelynx/rozelynx` via
setcap in `pkg_postinst`.

### Distro-agnostic (any Linux)

`scripts/firefox-librewolf/rozelynx-distro-build.sh` reproduces the
whole ebuild flow on any distro: it pulls **versioned, pinned**
Firefox, LibreWolf and Floorp sources (the pin file is
`rozelynx-distro-versions.conf` next to the script), applies the
Gentoo patchset, the LibreWolf privacy patch set vendored in this
overlay, and the full RozeLynx patch/branding/extension sequence,
then builds and stages the browser.

```sh
cd scripts/firefox-librewolf

# full build + all package formats:
./rozelynx-distro-build.sh all --appimage --flatpak --snap

# or step by step:
./rozelynx-distro-build.sh fetch prepare configure build install
./rozelynx-distro-build.sh package --tarball

# inspect/override the feature set (same names as the USE flags):
./rozelynx-distro-build.sh --list-flags
./rozelynx-distro-build.sh --no_use net-iface --use pgo all --appimage
```

Notes:

- Everything is pinned in `rozelynx-distro-versions.conf`:
  the Firefox source tarball and checksums, the Gentoo firefox
  patchset, the LibreWolf and Floorp reference checkouts, the
  appimagetool release, the Flatpak runtime and the snap base.
  The LibreWolf patches applied are the ones vendored in this overlay
  (already rebased per Firefox version); the pinned upstream
  LibreWolf and Floorp checkouts are kept as reference sources only -
  Floorp features are ported into RozeLynx's own code, not applied as
  patches.
- Feature flags match the ebuild's USE flag names one-to-one
  (`--use`/``--no_use``, repeatable, comma-separated).
- Packaging: `--tarball` (a `usr/` tree for any distro with a
  new-enough glibc), `--appimage`, `--flatpak` (needs flatpak,
  flatpak-builder and the pinned runtime installed) and `--snap`
  (needs snapd). The net-iface `CAP_NET_RAW` capability survives the
  tarball and snap pack; AppImage mounts are nosuid, so grant
  `cap_net_raw` to the extracted binary if you need interface pinning
  there.
- `./rozelynx-distro-build.sh --help` for every option, including
  `--workdir`, `--jobs`, `--prefix`/`--libdir` and API-key injection
  via `ROZELYNX_API_KEY_*` variables.

### Where things live

- `scripts/firefox-librewolf/` - patch tree (source of truth):
  LibreWolf patches at the top level, `ui-patches/`, the RozeLynx
  tree in `rozelynx/`, root patches in `root-patches/`
- `scripts/firefox-librewolf/firefox-template.ebuild` - the patched
  ebuild template (regenerated into `www-client/firefox/` on sync)
- `scripts/firefox-librewolf/rozelynx-distro-build.sh` - the
  distro-agnostic build
- `www-client/firefox/tests/` - 2000+ checks across the source tree,
  a fresh extension assembly and the portage mirror
  (`tests/run.sh`)
- `www-client/firefox/` - the working ebuild + files (restored by
  `apply.sh` after every upstream sync)

## License

See [LICENSE](LICENSE): MPL-2.0 for the browser patch tree and the
built RozeLynx, GPL-2 for the Gentoo ebuild packaging, plus
LGPL-2.1-licensed components in the built browser. The full license
texts live in [licenses/](licenses/).
