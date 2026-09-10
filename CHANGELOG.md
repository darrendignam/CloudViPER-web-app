# Changelog

All notable changes to CloudViPER are recorded here. Format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versioning follows
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

CloudViPER 2.0 tracks ViPER 2.0. Both moved to a Selkies desktop stack on
Ubuntu 26.04 in the same release cycle.

## [2.0.0-alpha.0] - 2026-09-10

### Added

- `SelkiesControlPlane` service: a typed client for the in-container Selkies
  token control plane, with `SelkiesControlPlaneError` distinguishing a rejected
  request (carries the HTTP status) from an unreachable or timed-out container.
- `ViperInstanceService.grantInstanceAccess()` mints a per-session token and
  registers it as the container's only credential. Each call displaces the
  previous token, so relaunching an instance invalidates any earlier link.
- `ViperInstanceService.revokeInstanceAccess()` drops every token, disconnecting
  live viewers. Called on termination.
- `GET /service/launch/:instanceUUID` mints a token and frames the desktop, so
  the token stays out of the address bar, browser history and any copied URL.
  Sends `Referrer-Policy: no-referrer`.
- `GET /service/auth/instance/:instanceUUID` provides an ownership check for the
  reverse proxy's `auth_request` directive. Status only, no body.
- `helperFunctions.generateSessionToken()` for 32 bytes of base64url entropy.
- `VIPER_IMAGE`, `TEST_CORPUS_HOST_PATH`, `SELKIES_CONTROL_PORT` and
  `SELKIES_CONTROL_TIMEOUT_MS` environment variables, documented in
  `src/.env.example`.
- 37 tests covering the control plane client, token grant and revoke, and the
  launch and proxy-auth routes.

### Changed

- **BREAKING** Instance containers run the Selkies-based ViPER 2.0 image,
  `ghcr.io/darrendignam/opf-cloud-viper:2.0.0-alpha`, read from `VIPER_IMAGE`
  rather than hardcoded.
- **BREAKING** `ViperInstance.kasmvncPassword` is replaced by
  `ViperInstance.masterToken`. Instances created before this release have no
  master token and cannot be launched; they must be recreated.
- Instances start in Selkies secure mode via `SELKIES_MASTER_TOKEN` instead of
  KasmVNC basic auth via `PASSWORD`.
- In-desktop sharing is disabled by default (`SELKIES_ENABLE_SHARING`,
  `SELKIES_ENABLE_COLLAB`, `SELKIES_ENABLE_SHARED` all `false`). Note this is a
  default, not an enforced control: the Selkies master token is passed to the
  container as an environment variable and is therefore readable from inside the
  desktop session, so a determined user can mint their own token regardless. See
  [SELKIES_MASTER_TOKEN_EXPOSURE.md](docs/SELKIES_MASTER_TOKEN_EXPOSURE.md).
- Instance list entry points link to `/service/launch/:uuid` rather than the raw
  instance URL, which now loads a page that cannot stream without a token.
- Container environment is logged by variable name only. It previously printed
  every value, including credentials, to stdout.

### Fixed

- **Instance provisioning never ran.** `Dockerfile` copied `web-app/scripts/`,
  which holds no monitoring scripts, so `validateRequiredScripts()` failed in the
  image and `createInstance` downgraded it to a warning. The repository-root
  scripts are now copied in, and `scriptManager` resolves its directory by
  probing both the built and source layouts, so a dev run and the image read the
  same files. `SCRIPTS_DIR` overrides the search.
- `helperFunctions.generateRandomString()` draws from `crypto.randomBytes` with
  rejection sampling instead of `Math.random()`. It previously generated the
  instance UUID, status key and account passwords from a predictable PRNG whose
  internal state is recoverable from a few outputs.
- `/service/viperinstances` no longer returns `masterToken` or `statusKey` to
  the browser. The predecessor field `kasmvncPassword` and `statusKey` were both
  present in that payload.

### Security

The two fixes above close a chain in which an attacker holding one instance URL
could derive the credentials of that instance and predict those of every
instance created afterwards.

### Removed

- The systemd user unit written into every instance. Init in the LinuxServer
  images is `s6-svscan` and `/run/systemd/system` does not exist, so the file was
  written, chowned, chmodded and never read. `scripts/viper-monitor.service` is
  deleted with it. The XDG autostart entry is what starts the monitor, and MATE
  honours it from `abc`'s home at `/config/.config/autostart`.
- `rm -f /etc/sudoers.d/abc` from instance hardening. ViPER 2.0 ships no such
  file and `sudo` already requires a password. Removing `abc` from the `sudo`
  group is kept, since that membership is still present.
- `xdotool` and `curl` from the runtime `apt-get install`, since both ship in the
  ViPER 2.0 image. `xinput` too: nothing in the repository ever used it. It was
  presumably added for the keyboard event counter in `viper-monitor.sh`, which is
  initialised, reported and reset but never incremented, so `keyboardEvents` has
  always been zero. Only `scrot` and `bc` are now installed at runtime.

### Notes

Selkies enforces tokens after the WebSocket handshake, not at nginx. An
unauthenticated client receives `101 Switching Protocols` and is then closed
with code 4001 before any frame is sent. Revoked clients close with 4002.
Verified against a running build; see `docs/SELKIES_MIGRATION.md` section 10.

The test corpus desktop entry is now a symlink created as `abc`, not a
`Type=Link` .desktop file. Caja refuses to open a launcher without the
`caja-trusted-launcher` metadata flag, which ViPER's own post-install sets before
CloudViPER's provisioning runs. `chown -h` on a symlink is a no-op in the
container, so the link is created as `abc` instead of created as root and chowned.
