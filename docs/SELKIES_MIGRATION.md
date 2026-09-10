# Selkies Migration and Per-Session Auth Design

**Date:** 2026-09-04, revised 2026-09-10
**Status:** Design verified against a running ViPER v2.0.0-alpha build. Target release: CloudViPER 2.0.0.
**Branch:** `docker-ipres-2026`
**Scope:** Replacing the retired KasmVNC desktop stack with LinuxServer's Selkies base image, and the reverse proxy / authentication changes that follow.

> Revision note (2026-09-10): the auth design in sections 3 and 4 has now been **exercised end to end** against `viper-2.0.0-alpha:local`. See section 10 for the evidence. Items still marked **unverified** need a test pass before you rely on them.

---

## 1. Why this is needed

LinuxServer has retired the KasmVNC base images. They receive no further updates, including security patches.

| Component | Last upstream commit |
|---|---|
| `docker-webtop` branch `ubuntu-xfce-kasm` | 2026-07-04, "Disabling future builds" |
| `baseimage-kasmvnc`, all branches | 2025-07-12 |

**There is no Noble landing spot.** `baseimage-selkies:ubuntunoble` was disabled 2026-06-21, and the `debianbookworm` / `debiantrixie` branches were deleted. The only live Debian-family flavour is `ubunturesolute`. Choosing Selkies is choosing Ubuntu 26.04; the two decisions are not separable.

ViPER v2.0.0 ships from the **bare base image**, not `webtop:ubuntu-mate`:

```
ghcr.io/linuxserver/baseimage-selkies@sha256:2b3da429ebb59b491def140acdb52a21af7cb9f7d000bd27c58fc3ef63a762fc
```

Webtop installs a desktop that ViPER's Ansible then installs over the top of, plus chromium and a PPA that gets stripped. The bare base is 653 packages with no desktop.

**Consequence for CloudViPER:** anything the old XFCE base provided for free is gone. ViPER lost `mousepad` this way without noticing. If CloudViPER assumes any binary exists in the instance container that ViPER does not explicitly install, verify it.

Legacy `*-kasm-*` tags still pull, so nothing breaks today. But CloudViPER is currently pinned to a frozen, unpatched branch of an image that runs untrusted user desktops. That is the reason to move, independent of any feature gain.

## 2. What actually changed

### 2.1 The transport is not WebRTC

Most search results, and the older Selkies-GStreamer documentation, describe a WebRTC stack requiring CoTURN (STUN/TURN). **That is the old Selkies.** LinuxServer's current base image streams over a single WebSocket with WebCodecs decode (pixelflux).

**Verified** from the shipped nginx config, `root/defaults/default.conf`:

```nginx
location SUBFOLDERwebsocket {
  proxy_set_header Upgrade $http_upgrade;
  proxy_set_header Connection "upgrade";
  proxy_http_version 1.1;
  proxy_read_timeout 3600s;
  proxy_buffering off;
  proxy_pass http://127.0.0.1:CWS;   # CWS = CUSTOM_WS_PORT, default 8082
}
```

One WebSocket, one upgrade, no peer connection, **no TURN or STUN server required**. This is less proxy machinery than the current KasmVNC setup, not more.

`SUBFOLDER` and `CWS` are literal placeholders substituted at container start.

### 2.2 Ports

| Port | Purpose | Expose? |
|------|---------|---------|
| 3000 | HTTP. Proxy this. | Behind the edge proxy |
| 3001 | HTTPS with a self-signed cert | Not needed, see 5.1 |
| 8082 | WebSocket, fronted by the container's own nginx | Internal only |
| 8083 | Control plane API for token management | **Never expose publicly.** Only listens when `SELKIES_MASTER_TOKEN` is set. |

### 2.3 nginx locations inside the container

| Location | Backend | Notes |
|----------|---------|-------|
| `SUBFOLDER` | `/usr/share/selkies/web/` | Static client. No auth unless `PASSWORD` set. See warning below. |
| `SUBFOLDERwebsocket` | `127.0.0.1:8082` | The stream |
| `SUBFOLDERfiles` | `FILE_MANAGER_PATH` | Download listing, fancyindex |
| `SUBFOLDERpelorus/` | `127.0.0.1:5100` | Agentic web interface, only if `PELORUS=true` |
| `/devmode` | `127.0.0.1:5173` | Dev server, not used in production |

> **The web root is `/usr/share/selkies/web/`, not `www`.** Both directories exist in the image, which invites the mistake. `/usr/share/selkies/www/` holds only `favicon.ico` and `icon.png` and is referenced by no nginx config. Verified on the running v2.0.0-alpha build: the favicon served over HTTP is the stock Selkies one, while a different `favicon.ico` sits unserved in `www/`. Branding written to `www/` silently does not apply. The old `/kclient/public` path is gone entirely.

### 2.4 Subfolder routing is native

`SUBFOLDER` accepts a path in `/subfolder/` form (both slashes required) and rewrites all locations accordingly. Path-based routing such as `/viper-instances/{uuid}/` works without a sidecar. The nginx sidecar hand-built on the `kubernetes-gke` branch is no longer necessary.

### 2.5 Relevant environment variables

| Variable | Default | Purpose |
|----------|---------|---------|
| `SELKIES_MASTER_TOKEN` | unset | Enables secure mode. Required for per-session tokens. |
| `SELKIES_CONTROL_PORT` | `8083` | Control plane API port |
| `CUSTOM_WS_PORT` / `SELKIES_PORT` | `8082` | WebSocket port |
| `CUSTOM_PORT` | `3000` | HTTP port |
| `CUSTOM_HTTPS_PORT` | `3001` | HTTPS port |
| `SUBFOLDER` | `/` | Reverse proxy subpath |
| `CUSTOM_USER` / `PASSWORD` | `abc` / unset | HTTP basic auth. See 3.1. |
| `SELKIES_ENABLE_SHARING` | `True` | Master toggle for in-desktop share links. See 7.2. |
| `SELKIES_ENABLE_COLLAB` | `True` | Read-write share links |
| `SELKIES_ENABLE_SHARED` | `True` | View-only share links |
| `PIXELFLUX_WAYLAND` | unset | Wayland mode. Needs AVX2, see 7.3. |
| `TITLE` | `Selkies` | Browser page title |

---

### 2.6 Runtime facts that carried over, and that did not

Unchanged, so less work than the migration sounds like:

- `/defaults/startwm.sh` is still the session launcher, same contract.
- `/config` is still the volume, `abc` is still the user. `PUID`, `PGID`, `TZ` and `TITLE` still apply.
- Port 3000 is still the HTTP port to proxy.

Changed:

- **`DISPLAY=:1`** in X11 mode, which is the default. Verified on the running build. Selkies uses `:0` only under `PIXELFLUX_WAYLAND`. Any code that hardcodes a display breaks silently if Wayland is enabled later.
- **Session bus race is fixed upstream.** The old stack died roughly one boot in nine with `mate-session` running and no children behind a "Could not connect to session bus" dialog, because `svc-de` did not depend on the X server. Selkies declares `svc-de` after `svc-xorg`, closing the race. ViPER additionally uses `dbus-run-session` rather than the stock `dbus-launch --exit-with-session`, which removes the failure mode instead of narrowing it. Worth copying if CloudViPER ever launches sessions itself.

## 3. Authentication

### 3.1 What not to use

`CUSTOM_USER` / `PASSWORD` gives HTTP basic auth via the container's nginx. It is static per container, shared by everyone who reaches it, and cannot be revoked without a restart. LinuxServer's own documentation says it "should be used to keep the kids out not the internet."

This is functionally what CloudViPER does today via `kasmvncPassword`. It is the thing to move away from.

### 3.2 The control plane token API

Setting `SELKIES_MASTER_TOKEN` puts the container in secure mode. Tokens are then registered against a control plane API on port 8083.

The upstream README describes this port as "meant for integrators that want to wrap the baseimage in their own platforms and handle authentication." That is precisely CloudViPER's role.

**Endpoint:** `POST /tokens`
**Auth:** `Authorization: Bearer <SELKIES_MASTER_TOKEN>`
**Body:** JSON object mapping token strings to permission objects.

```bash
curl -X POST http://<container>:8083/tokens \
  -H "Authorization: Bearer $SELKIES_MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{
    "a1b2c3...": {"role": "controller", "slot": null, "mk_control": false}
  }'
```

| Field | Type | Required | Meaning |
|-------|------|----------|---------|
| `role` | `"controller"` or `"viewer"` | yes | Full input access, or view-focused |
| `slot` | integer 1-4, or `null` | yes | Virtual gamepad slot assignment |
| `mk_control` | boolean | no | Exclusive mouse and keyboard override. If `true` on any active token, only that client processes mouse and keyboard. |

The client connects with the token as a query parameter: `?token=...`

### 3.3 Two semantics that constrain the design

**A POST replaces the entire token set.** The server then reconciles:

1. Clients holding tokens absent from the new set are disconnected immediately.
2. Clients whose tokens survive but whose permissions changed receive a state update without a reconnect.

This gives instant revocation for free, which CloudViPER has no equivalent of today. POST an empty or replacement set on terminate, logout, or session expiry.

**Verified** on the running build: a live client whose token is omitted from a replacement set is dropped with close code **4002** `Token revoked`. POSTing `{}` drops every client. Both take effect within a second.

**You cannot rotate a token mid-session.** Because absent tokens disconnect their clients, the token issued at launch must stay valid for the life of the session. There is no way to shorten a live token's lifetime without dropping the user.

### 3.4 Enforcement happens after the WebSocket handshake, not at nginx

**Verified.** nginx upgrades the connection regardless of the token. All three of no token, a valid token and a bogus token return `101 Switching Protocols`. The Selkies server then authenticates on the open socket:

| Case | Handshake | Outcome |
|------|-----------|---------|
| No token | 101 | Closed, code **4001** `Invalid authentication token`. Zero frames sent. |
| Bogus token | 101 | Closed, code **4001** `Invalid authentication token`. Zero frames sent. |
| Valid token | 101 | First frame `AUTH_SUCCESS,{"role": "controller", "slot": null}`, stream follows. |
| Token revoked mid-session | n/a | Closed, code **4002** `Token revoked`. |

Two consequences:

- **No data leaks to an unauthenticated client.** Zero frames before the close. The security property holds.
- **An unauthenticated client can still complete a handshake** and hold a socket until the server closes it. A minor unauthenticated resource surface. Rate limiting at the edge is worth considering if instances are internet-facing.

Close codes 4001 and 4002 are distinguishable, so the launch page can tell "your link is bad" from "your session was ended" if it handles the socket itself.

### 3.5 The token gates the stream, not the page

`location SUBFOLDER` serves the static client with no authentication unless `PASSWORD` is set. Secure mode rejects the **WebSocket**, not the HTML.

So a user who reaches the URL without a token gets a functioning page that cannot connect. That is not sufficient on its own: the page reveals the instance exists, and any future client-side surface is unprotected. An HTTP-layer gate is still wanted.

---

## 4. Proposed design: two layers

### 4.1 Layer 1, the page: `auth_request`

Gate the instance at the edge proxy against the CloudViPER session.

The endpoint already exists in the right shape on the `kubernetes-gke` branch as `/service/auth/instance/:instanceUUID`. It is only commented out of the proxy config (`k8s/viper-proxy-configmap.yaml:64`, "DISABLED FOR NOW - DNS resolution issues"). Port it to the docker proxy and re-enable.

It must verify: valid session, and that the session's user owns (or is admin/team-permitted for) that instance UUID.

### 4.2 Layer 2, the stream: per-session token

```
Browser                Express (CloudViPER)         Instance container
   |                          |                             |
   |  GET /service/launch/:uuid                             |
   |------------------------->|                             |
   |                          | verify session + ownership  |
   |                          | token = randomBytes(32)     |
   |                          | POST :8083/tokens           |
   |                          |---------------------------->|
   |                          |         200 OK              |
   |                          |<----------------------------|
   |   render page, iframe src carries ?token=              |
   |<-------------------------|                             |
   |                                                        |
   |  GET / (auth_request -> Express: session valid?)        |
   |------------------------------------------------------->|
   |  WS /websocket?token=...                                |
   |------------------------------------------------------->|
   |                                                        |
   |  (on terminate/logout) POST :8083/tokens {}            |
   |                          |---------------------------->|
   |                          |    live clients dropped     |
```

Sketch, to be fleshed out against `ViperInstanceService`:

```ts
async mintSessionToken(instance: ViperInstance, role: 'controller' | 'viewer' = 'controller') {
  const token = crypto.randomBytes(32).toString('base64url');
  await fetch(`http://${instance.name}:8083/tokens`, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${instance.masterToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ [token]: { role, slot: null, mk_control: false } }),
  });
  return token;
}
```

Notes:
- `masterToken` becomes a new per-instance column, generated with `crypto.randomBytes` and passed as `SELKIES_MASTER_TOKEN` at container create. It never leaves the server.
- Port 8083 must be reachable from the web app container but from nothing else. On the Docker network that means not publishing it, and ideally a dedicated network.
- Replaces `kasmvncPassword` entirely. That column and its exposure (see 6.4) can go.

---

## 5. Reverse proxy changes

### 5.1 HTTPS is now mandatory

WebCodecs requires a secure browser context. The existing nginx-proxy plus acme-companion setup terminates TLS at the edge and speaks HTTP to the container, so the browser sees `https://` and the requirement is met. **The container's port 3001 and self-signed cert are not needed.**

For local development: `http://localhost` is a secure context and works. `http://<ip>` is not and will fail to stream.

### 5.2 WebSocket upgrade

Already handled for KasmVNC. Same requirement, same headers. Long `proxy_read_timeout` matters; the container's own config uses 3600s.

### 5.3 Net change

Point the upstream at container port 3000, keep the upgrade block, add the token mint on launch, drop the `PASSWORD` env var. Smaller than it sounds.

---

## 6. Token exposure and how to contain it

`?token=` in a URL is not exposed on the wire (query strings are inside the TLS payload; only the SNI hostname is visible). It **is** exposed in four places that matter.

### 6.1 Where it leaks

| Vector | Severity | Note |
|--------|----------|------|
| Access logs | High | nginx `combined` logs `$request`, including the query. Lands in edge proxy and container logs, then in rotation and backups. |
| Browser history | Medium | Full URL persists after the session. Relevant on shared workshop machines. |
| Shoulder surfing / screen share | Medium | The address bar is on the projector during a demo. |
| Copy-paste | Medium | Selkies allows multiple clients per token, so a shared URL grants a silent second controller. |
| `Referer` header | Low | Modern browsers default to `strict-origin-when-cross-origin`, which strips path and query cross-origin. |

### 6.2 The obvious fix does not work

Stripping the token from the address bar with `history.replaceState()` **breaks the client**. **Verified** from `addons/selkies-web-core/lib/session-token.js`:

```js
export function getSessionToken() {
    return new URLSearchParams(window.location.search).get('token') || '';
}
```

Every consumer calls this live on each use: `sessionAuthHeaders()` for XHR, `withSessionToken()` for iframe and link URLs, and the WebSocket handshake. Remove it from the URL and they all return empty.

There is a `selkies_token` cookie, but `installSessionCookie()` only ever **writes** it, sourced from the URL, scoped to `{prefix}/api/` with `SameSite=Strict`. Nothing reads it back into `getSessionToken()`. It covers browser-initiated `/api/` requests such as download links. **It is not an alternative carrier.**

Conclusion: the token must remain in the page URL for the session's life.

### 6.3 Proportion

The current design already puts the secret in a URL. The instance UUID in `{uuid}.APP_HOST` *is* the access control today, and a hostname leaks harder than a query string: it goes out in cleartext TLS SNI and in DNS queries to every resolver on the path.

A revocable token in a query string is a net improvement over a permanent UUID in a hostname.

### 6.4 Mitigations

- **Scrub the query from access logs.** Highest value, lowest effort.

  ```nginx
  map $request_uri $clean_uri { ~^(?<p>[^?]*)  $p; }
  log_format notoken '$remote_addr [$time_local] "$request_method $clean_uri $server_protocol" '
                     '$status $body_bytes_sent "$http_referer" "$http_user_agent"';
  access_log /var/log/nginx/access.log notoken;
  ```

- **Serve the desktop in an iframe** rather than redirecting. `/service/launch/:uuid` renders a page instead of issuing a 302: the parent URL stays clean, the token rides on the `iframe src`. Browser history records the parent, the address bar shows the parent, and a copied URL carries no token. Kills three of the four vectors at once.

  **Partly verified.** The container sets no `X-Frame-Options` and no CSP `frame-ancestors`, so framing is not blocked at the header level, and no `Cross-Origin-*` isolation headers are set that would interfere. The LSIO dashboards already iframe the file manager. Still needs a visual pass for `allow="fullscreen; clipboard-read; clipboard-write"` behaviour before committing.

- **`Referrer-Policy: no-referrer`** on instance responses. One header.

- **Revoke aggressively.** POST `{}` to the control plane on terminate, logout, and session expiry. The live token's lifetime cannot be shortened, but the window can be made equal to the session rather than indefinite.

---

## 7. Risks and watch items

### 7.1 Existing issues that carry over

These are not caused by the migration but should be fixed alongside it. See [Security-Report-2026.md](../Documentation/Security-Report-2026.md).

- `Math.random()` generates instance secrets (`utility/helperFunctions.ts:27`). Any new token generation must use `crypto.randomBytes`. Do not extend `generateRandomString`.
- `/service/viperinstances` returns `kasmvncPassword` and `statusKey` to the browser. Its `attributes: { exclude: [...] }` list does not cover them. Migration is the natural moment to drop both from the payload.

### 7.2 In-desktop sharing is on by default, and cannot be fully enforced

> The master token reaches the desktop session's environment, so a user can mint
> their own tokens whatever these are set to. Setting them false is still worth
> doing, but treat it as a default rather than a control. Full analysis and the
> options in [SELKIES_MASTER_TOKEN_EXPOSURE.md](SELKIES_MASTER_TOKEN_EXPOSURE.md).


`SELKIES_ENABLE_SHARING`, `SELKIES_ENABLE_COLLAB` and `SELKIES_ENABLE_SHARED` all default to `True`. A user inside a desktop can generate collaborative or view-only share links. For a workshop with attendee isolation, set these to `false` unless the feature is wanted deliberately.

### 7.3 Wayland needs AVX2

`PIXELFLUX_WAYLAND=true` requires an x86_64 CPU with AVX2 (Haswell or newer). Without it the container silently falls back to X11. Confirm the CPU when picking the Hetzner instance. GPU acceleration for X11 is no longer developed upstream.

### 7.4 Passwordless sudo persists

LinuxServer still documents privileged access inside the desktop. The existing `removeSudoAccess` provisioning step stays relevant, and remains a reason to keep instance containers off any network that reaches MySQL or the Docker socket.

### 7.5 Not a route: SealSkin

LinuxServer's SealSkin platform covers similar ground (disposable desktops, public/private key auth). Its documentation states it "is not designed to work with a reverse proxy." It is not compatible with the CloudViPER architecture. Ruled out.

### 7.6 Not a route: JWT or Boundary

- **JWT.** Selkies does not validate JWTs; it does opaque string matching against a registered set. A signed token would still need registering with the control plane, so it buys nothing over random bytes. The Express session is already the identity layer.
- **HashiCorp Boundary.** An identity-aware broker for SSH, RDP, databases and TCP. Reaching a web app requires a client agent or a brokered localhost port, which does not fit handing a workshop attendee a URL. Possibly of interest later for auditable admin access to the host; not for instance access.

---

## 8. Migration checklist

Sizes: 🟢 small (<½ day), 🟡 medium (½-2 days), 🔴 large (multi-day).

### Base image
- [x] 🟢 Instance image rebuilt on Selkies. **Done upstream** as ViPER v2.0.0-alpha, on the bare base pinned by digest.
- [x] 🟢 Registry reference set to `ghcr.io/darrendignam/opf-cloud-viper:2.0.0-alpha`, overridable via `VIPER_IMAGE`
- [ ] 🟡 Re-verify the preservation toolchain under the new base as launched by CloudViPER, not just standalone
- [ ] 🟢 Confirm the test corpus bind mount and desktop shortcut still resolve. Note the host path `/var/viper-docker-project/volumes/test-corpus/...` is a packaging dependency.
- [x] 🟢 Audited the binaries CloudViPER assumes. `xdotool` and `curl` ship in the image; `scrot` and `bc` do not and are installed at runtime. Ask the ViPER build to carry those two and the step disappears. `xinput` was dropped: nothing used it.
- [ ] 🟢 `viper-monitor.sh` never increments `KEYBOARD_EVENTS`, so `keyboardEvents` is always zero in the Activity model and the admin UI. Either implement it or drop the field.

### Application
- [x] 🟡 `masterToken` column on `ViperInstance`, generated with `crypto.randomBytes`
- [x] 🟢 `SELKIES_MASTER_TOKEN` passed at container create; `PASSWORD` dropped
- [x] 🟡 `SelkiesControlPlane` client plus `grantInstanceAccess()` / `revokeInstanceAccess()`
- [x] 🟡 `/service/launch/:uuid` mints a token and frames the desktop
- [x] 🟢 Revoke on terminate
- [ ] 🟢 Revoke on logout and session expiry. Terminate is wired; the session hooks are not.
- [x] 🟢 `kasmvncPassword` removed from the model and from `/service/viperinstances`
- [x] 🟢 Instance list links routed through `/service/launch/:uuid`

### Proxy
- [x] 🟡 `/service/auth/instance/:instanceUUID` implemented, status-only, denies on lookup failure
- [x] 🔴 **Decided 2026-09-10: `auth_request` stays unwired.** The session cookie is host-only for the app domain, so a subrequest for `<uuid>.<domain>` carries no cookie and the endpoint would deny every desktop, including the owner's. Making it work needs `domain: '.<domain>'` on the session cookie, which sends that cookie into every instance container, where users have a shell. That is a worse position than the per-desktop Selkies token it was meant to strengthen. Revisit with a per-instance signed cookie set on the instance host at launch, not with the session cookie.
- [ ] 🟢 Point the upstream at container port 3000
- [ ] 🟢 Add the `notoken` log format at the edge
- [x] 🟢 `Referrer-Policy: no-referrer` sent by the launch route

### Hardening
- [x] 🟢 `SELKIES_ENABLE_SHARING`, `_COLLAB` and `_SHARED` set to `false` at container create
- [ ] 🟢 Keep port 8083 off any published or shared network. Not published; still shares `cloud-viper-net` with the web app and MySQL.
- [x] 🟢 `Math.random()` replaced with `crypto.randomBytes` and rejection sampling
- [x] 🟢 Container environment logged by variable name only, not by value

### Verification
- [x] 🟢 Control plane auth, WebSocket enforcement and revocation proven against a live build. See section 10.
- [ ] 🟡 **Visual pass on the iframe approach.** Headers are clear; fullscreen and clipboard behaviour untested. Blocks the 6.4 mitigation.
- [ ] 🟢 Confirm AVX2 on the target host, or accept the X11 fallback
- [ ] 🟡 Load test: concurrent desktops on one host, since WebCodecs encoding is CPU-bound without a GPU

---

## 9. References

- [baseimage-selkies documentation](https://docs.linuxserver.io/images/docker-baseimage-selkies/)
- [baseimage-selkies README, control plane API](https://github.com/linuxserver/docker-baseimage-selkies/blob/master/README.md)
- [webtop documentation](https://docs.linuxserver.io/images/docker-webtop/)
- [Spring Cleaning: rebasing announcement](https://www.linuxserver.io/blog/spring-cleaning-new-images-and-rebasing)
- [Webtop 3.0 and SealSkin](https://www.linuxserver.io/blog/webtop-3-0-part-3-putting-it-all-together-with-sealskin)
- [selkies session-token.js](https://github.com/selkies-project/selkies/blob/main/addons/selkies-web-core/lib/session-token.js)
- [HashiCorp Boundary](https://developer.hashicorp.com/boundary)

---

## 10. Verification log

Run 2026-09-10 against `viper-2.0.0-alpha:local`, the ViPER v2.0.0-alpha build, on Docker. Every claim in sections 2 to 4 marked *verified* comes from this pass.

**Secure mode gates the control plane.** With `SELKIES_MASTER_TOKEN` unset, the container listens on 3000, 3001 and 8082 only. Setting it adds 8083. The control plane does not exist outside secure mode.

**Both 8082 and 8083 bind `0.0.0.0` inside the container.** They are unreachable from outside only because they are unpublished. On a shared Docker network any other container can reach the control plane. Do not publish 8083, and keep instance containers off any network that does not need them.

**Control plane auth works as documented.**

```
POST /tokens, no Authorization header        -> 401
POST /tokens, Authorization: Bearer <master> -> 200 OK
```

**WebSocket enforcement, via the `ws` client rather than curl**, because curl only shows the handshake:

```
NO TOKEN     opened=true msgs=0 close=4001 reason="Invalid authentication token"
VALID TOKEN  opened=true msgs=6 close=null  first frame: AUTH_SUCCESS,{"role": "controller", "slot": null}
BOGUS TOKEN  opened=true msgs=0 close=4001 reason="Invalid authentication token"
```

**Revocation.**

```
register tok-live, connect            -> AUTH_SUCCESS
POST a set omitting tok-live          -> live client CLOSED code=4002 "Token revoked"
POST {} with another client connected -> CLOSED code=4002 "Token revoked"
```

**Framing.** No `X-Frame-Options`, no CSP `frame-ancestors`, no `Cross-Origin-*` headers.

**Web root.** `/usr/share/selkies/web/` is served. `/usr/share/selkies/www/` exists, is referenced by no nginx config, and holds a `favicon.ico` that differs from the one actually served. Confirmed by comparing the md5 of `GET /favicon.ico` against both files on disk.
