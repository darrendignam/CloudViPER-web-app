# The instance master token is readable from inside the desktop

**Date:** 2026-09-10
**Status:** Known issue, accepted for 2.0.0-alpha. Decision required before a production release.
**Affects:** CloudViPER 2.0.0-alpha, every ViPER instance it launches.
**Severity:** Medium. It breaks a claim made in the CHANGELOG and removes one guarantee. It does **not** allow one user to reach another user's desktop.

> Every statement below marked **verified** was reproduced against
> `ghcr.io/darrendignam/opf-cloud-viper:2.0.0-alpha` on 2026-09-10. Commands and
> outputs are in section 6.

---

## 1. What happens

CloudViPER puts each instance into Selkies secure mode by passing
`SELKIES_MASTER_TOKEN` as a container environment variable
(`ViperInstanceService.ts`, `createInstance`). That token is the bearer credential for
the container's control plane on port 8083, which mints and revokes the session tokens
that grant desktop access.

The LinuxServer base image starts the desktop like this:

```bash
#!/usr/bin/with-contenv bash      # /etc/s6-overlay/s6-rc.d/svc-de/run
...
exec s6-setuidgid abc /bin/bash /defaults/startwm.sh
```

`with-contenv` exports everything in `/run/s6/container_environment/` into the service,
and `s6-setuidgid abc` then runs the desktop as the user with that environment. So the
token is in the desktop session's own environment, and every terminal the user opens
inherits it.

**Verified.** Reading the live session's environment directly:

```
$ docker exec viper-a sh -c 'p=$(pgrep -x mate-session); tr "\0" "\n" < /proc/$p/environ | grep SELKIES'
SELKIES_MASTER_TOKEN=MASTER-AAA
```

## 2. What a user can do with it

A user in their own desktop opens a terminal and runs:

```bash
curl -X POST http://127.0.0.1:8083/tokens \
  -H "Authorization: Bearer $SELKIES_MASTER_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"i-made-this":{"role":"controller","slot":null}}'
```

**Verified:** returns `200`, and a WebSocket opened with `?token=i-made-this` receives
`AUTH_SUCCESS,{"role": "controller", "slot": null}` and streams.

Two consequences follow.

**They can share their desktop.** They hand out the URL with their own token. This
directly contradicts the CHANGELOG, which states that with `SELKIES_ENABLE_SHARING=false`
"a user cannot generate share links from inside their desktop". That sentence is wrong
and must be corrected.

**They can revoke CloudViPER's token.** A control plane POST replaces the entire token
set, so the token CloudViPER issued at launch is dropped and its holder is disconnected
with close code 4002. Self-inflicted in the normal case; a way to eject a legitimate
viewer where one exists.

## 3. What a user cannot do

This is the part that keeps the severity at medium rather than high.

**They cannot reach another user's desktop.** Each instance gets its own master token
from `crypto.randomBytes`. Instance A can reach instance B's control plane over the
shared Docker network, but presenting A's master token to B is rejected.

**Verified:**

```
A -> B control plane, no auth              : HTTP 401
A -> B control plane, with A's own master  : HTTP 401
A -> B web port                            : HTTP 200
```

**They gain nothing they did not already have over their own session.** The user already
controls that desktop. The token adds the ability to admit *others*, not to escalate their
own access.

## 4. The compounding risk, which is the real reason to act

Two facts combine badly.

**Instance containers share `cloud-viper-net` with MySQL.** `createInstance` attaches every
instance to that network, and the database sits on it.

**Verified** from inside a desktop as the `abc` user:

```
MySQL 3306 REACHABLE from inside the desktop
```

**The database stores every instance's `masterToken` in plaintext.** It is a plain
`STRING` column on `ViperInstance`.

Reaching the port is not the same as reading the table, and no credentials are exposed to
the instance. But an untrusted user with an interactive shell and network line of sight to
a database that holds the credentials for every other desktop is a poor arrangement. A
weak database password, a MySQL vulnerability, or any future change that leaks
`DB_PASSWORD` into an instance turns a single-desktop issue into a full compromise.

**Network isolation is worth doing regardless of what is decided about the token**, because
it is what keeps this issue confined to one desktop.

## 5. Options

### Option A: accept, document, isolate the network

Correct the CHANGELOG, treat in-desktop sharing as a policy matter rather than a control,
and put instance containers on a network that cannot reach MySQL, the web app, or each
other.

- Keeps the security property that matters: an external attacker without a shell in the
  container still cannot reach any desktop.
- Removes the compounding risk in section 4.
- Leaves `SELKIES_ENABLE_SHARING=false` as a default rather than an enforced control.
- No upstream dependency.

### Option B: scrub the token after boot

Delete `/run/s6/container_environment/SELKIES_MASTER_TOKEN` once the container is up.

**Verified not to work.** It clears the value for shells started fresh through
`with-contenv`, but the desktop session started at boot already holds it in memory, and
its children inherit that copy:

```
$ docker exec viper-a rm -f /run/s6/container_environment/SELKIES_MASTER_TOKEN
$ docker exec viper-a sh -c 'p=$(pgrep -x mate-session); tr "\0" "\n" < /proc/$p/environ | grep SELKIES'
SELKIES_MASTER_TOKEN=MASTER-AAA
```

Do not rely on this. It is listed only so nobody spends a day rediscovering it.

### Option C: ask upstream for a token file

Selkies reads the master token from the environment because that is the only interface it
offers. A file path variable, say `SELKIES_MASTER_TOKEN_FILE`, read once at startup by the
Selkies process running as root, would keep it out of the desktop session entirely.

- The correct fix.
- Depends on the ViPER or LinuxServer release cycle, so it cannot gate CloudViPER 2.0.
- Worth raising now so it lands eventually.

### Option D: drop secure mode, gate at the proxy only

Rely solely on `auth_request` at the reverse proxy and stop using Selkies tokens.

- Not recommended. It gives up instant revocation and per-session credentials, which are
  the main gains of the 2.0 work, and replaces a scoped problem with a larger one: the
  container would accept any WebSocket that reaches it.

## 6. Reproduction

```bash
docker run -d --name viper-a --shm-size=1g --cap-add SYS_PTRACE \
  -e SELKIES_MASTER_TOKEN=MASTER-AAA -e PUID=1000 -e PGID=1000 \
  -p 3195:3000 ghcr.io/darrendignam/opf-cloud-viper:2.0.0-alpha

# 1. the token is in the live desktop session
docker exec viper-a sh -c 'p=$(pgrep -x mate-session); tr "\0" "\n" < /proc/$p/environ | grep SELKIES'

# 2. the desktop user can mint a working token
docker exec -u abc viper-a bash -c 'curl -s -X POST http://127.0.0.1:8083/tokens \
  -H "Authorization: Bearer $SELKIES_MASTER_TOKEN" -H "Content-Type: application/json" \
  -d "{\"i-made-this\":{\"role\":\"controller\",\"slot\":null}}"'

# 3. and it streams
#    ws://localhost:3195/websocket?token=i-made-this -> AUTH_SUCCESS

# 4. MySQL is reachable from the desktop when the instance is on cloud-viper-net
docker network connect cloud-viper-net viper-a
docker exec -u abc viper-a bash -c 'timeout 6 bash -c "</dev/tcp/cloud-viper-mysqldb/3306" && echo REACHABLE'
```

`--cap-add SYS_PTRACE` is only needed for step 1. Without it, root inside the container
cannot read another user's `/proc/<pid>/environ`, which is why this is not visible from a
casual look.

## 6a. Decision, 2026-09-10

**Accepted for 2.0.0-alpha. Not fixed.** The exposure stands as described above.

Of the actions this document called for, the CHANGELOG correction is done: the sharing
entry now says outright that the flags are a default and not an enforced control, and
links here.

Option A's network isolation is **not** done and is the next piece of work. It is not a
config tweak: instances currently share `cloud-viper-net` with the app and MySQL because
the ACME hooks curl `http://cloud-viper-gui-app:3000` for status callbacks, so isolating
them means giving instances a route to the app without a route to the database. That needs
a live stack to verify and should not be attempted alongside a demo.

Nothing here blocks the alpha: the exposure lets a user mint tokens to **their own**
desktop, which they already control. It does not reach another user's instance.

## 7. Recommendation

Take **Option A** for 2.0.0, and raise **Option C** with the ViPER team in parallel.

The single most valuable piece of work is the network isolation in Option A, and it is
worth doing whether or not the token exposure is ever fixed, because it is what stops one
compromised desktop from becoming a route to the database.

Until a decision is made, the CHANGELOG sentence claiming users cannot generate share
links should be corrected, since it is the only part of this that is currently stating
something untrue.

## 8. Related

- [SELKIES_MIGRATION.md](SELKIES_MIGRATION.md), section 3, for the token design this
  issue sits inside.
- `Documentation/Security-Report-2026.md` S4, which raised the absent `NetworkPolicy` for
  the Kubernetes deployment. The Docker deployment has the same gap for the same reason.
