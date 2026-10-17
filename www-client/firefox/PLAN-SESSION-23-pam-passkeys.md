# PLAN-SESSION-23: PAM passkeys (howdy face authentication / password fallback)

## Goal

Expand RozeLynx's passkey (WebAuthn) support with a local platform
authenticator whose user verification runs through PAM: howdy face
recognition first when the system stack carries `pam_howdy.so`, the
account password prompt as fallback. USB/NFC security keys keep
working in every configuration.

## Deliverables (all landed)

### New component: `rozelynx/cpp/webauthn-pam/`

Copied into `dom/webauthn/rozelynx-pam/` at prepare time, built into
libxul on GTK, links `-lpam`:

- `RozeLynxPamWebAuthnService.{h,cpp}` — nsIWebAuthnService platform
  authenticator; forwards everything it cannot serve (cross-platform
  attachment, foreign COSE algs, legacy U2F AppID, feature disabled)
  to the wrapped authrs_bridge. Register: exclusion check, chooser
  prompt for open attachment ("this device" vs "USB security key"),
  PAM verification, ES256 keypair, "none" attestation (zero AAGUID),
  credPropsRk per residentKey preference, private windows skip the
  store write. Sign: allow-list/discoverable matching, account
  picker when several match, PAM verification, ES256 assertion with
  the UP|UV flags set only after PAM succeeds, sign counter update
  (skipped in private windows). Conditional-mediation autofill
  entries come from the same store (resident creds only).
- `RozeLynxPamAuth.{h,cpp}` — one PAM transaction at a time on a
  dedicated thread (`RozeLynxPAM`); conversation callback marshals
  password requests to the main thread through the regular
  "webauthn-prompt" observer JSON; new prompt types:
  `rozelynx-pam-verify` (look at the camera), `rozelynx-pam-password`
  (promptPasswordBC -> pinCallback), `rozelynx-pam-select-authenticator`
  (chooser -> selectionCallback). Service resolution:
  `/etc/pam.d/rozelynx` -> `system-auth` -> `common-auth`
  (re-resolved per run). Cancels wake the conversation via monitor;
  completion always clears the doorhangers ("cancel" prompt).
- `RozeLynxPasskeyStore.{h,cpp}` — per-profile storage under
  `security.webauthn.rozelynx_pam.cred.<b64url-id>.{rpid,user,disp,
  handle,key,count,rk,created}`; unencrypted at rest like the
  profile's own logins (documented).
- `RozeLynxPamCrypto.{h,cpp}` — NSS session keypair (ES256) with
  PKCS#8 export/import, canonical-CBOR builders for the COSE EC2
  key, registration/assertion authenticatorData and the "none"
  attestation object. Byte-verified against authenticator-rs'
  AttestationObject deserializer (WebAuthnRegisterResult::
  Anonymize/HasIdentifyingAttestation round-trip through
  authrs_webauthn_att_obj_constructor).
- `moz.build` — sources, `OS_LIBS += ["pam"]`, LOCAL_INCLUDES for
  `/dom/webauthn` + `/security/manager/ssl`.
- `rozelynx.pam` — example `/etc/pam.d/rozelynx` (installed via
  newpamd by the ebuild, shipped in the tarball docs, written by the
  AUR rozelynx-bin package hook).

### Integration patches (same directory)

- `webauthn-pam-service.patch` — `dom/webauthn/moz.build` DIRS entry
  (gtk), `WebAuthnService.h` include + `MOZ_WIDGET_GTK` platform
  branch, `nsIWebAuthnService.idl` autofill provider constant
  `PROVIDER_PLATFORM_ROZELYNX_PAM = 5`. Applies to 156/157/158
  (files identical across those trees).
- `webauthn-pam-prompt-helper.patch` — WebAuthnPromptHelper.sys.mjs
  branches for the new prompt types + `webauthnDialog.ftl` strings.
- `webauthn-pam-static-prefs.patch` —
  `security.webauthn.rozelynx_pam.enabled` (RelaxedAtomicBool,
  default true): runtime switch, off = transparent pass-through to
  authrs and isUVPAA false.

### Wiring

- Gentoo ebuild (template + firefox-158.0.ebuild in all three
  overlays): `pam-passkeys` USE flag, REQUIRED_USE chain,
  `sys-libs/pam` in COMMON_DEPEND, src_prepare copy+eapply (gated
  `ver_test -ge 156.0`), `newpamd` in src_install, pkg_postinst
  elogs + flags list; metadata.xml + metadata-rozelynx-flags.xml.
- distro-agnostic build: flag `pam-passkeys` default-on, rozelynx-off
  force-off list, prepare block, pam.d example staged under
  `share/doc/rozelynx/pam.d/`, AppImage/flatpak/snap caveats
  (flatpak gets `--device=all` for the camera when the flag is on).
- AUR: rozelynx-git + rozelynx-bin gain `pam`, howdy optdepends;
  rozelynx-bin package() writes `/etc/pam.d/rozelynx`; .SRCINFO
  regenerated. /storage/src/rozelynx-bin (the published 156.0.1-4
  package) intentionally untouched until the next release tarball.

## Known limits (documented in README)

- PRF/large-blob extensions unsupported from the local authenticator.
- Cancel during a face capture is honored, but the camera session
  belongs to pam_howdy (drains on its own timeout).
- Keys unencrypted in the profile; face models are biometrics (same
  trade-off as any face unlock).
- Confined packages (flatpak/snap) may not reach host PAM/camera.

## Verification done

- `patch --dry-run` clean on the pristine 156 and 158 trees and a
  full sandbox apply (JS parses via node --check).
- bash -n on the distro script, template, and all three overlays'
  158 ebuilds; xmllint-equivalent parse of all metadata files.
- Byte-identical propagation checks across
  Documents/hawksnestsoftware/hawksnest-gentoo-overlay,
  /var/db/repos/hawksnest, Documents/ByteWheel/gentoo-overlay
  (both scripts/firefox-librewolf and www-client/firefox/files).
- Compile validation: not compiled in this session (full libxul
  build is hours; the concurrent 158 build session runs against the
  pre-pam-passkeys tree). First `USE=pam-passkeys` build will be
  the compile gate; watch dom/webauthn/rozelynx-pam/*.o.
