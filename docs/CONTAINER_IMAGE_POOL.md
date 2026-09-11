# CloudViPER 2.1: the container image pool

**Date:** 2026-09-10 into 2026-09-11
**Branch:** `v2.1.0-container-images`, off `fad842c` (the v2.0.0-alpha.0 tip)
**Status:** phases 1 to 4 built, green, and committed. Traefik routing ported in
on 2026-09-11 (see section 9) ahead of the vipercloud.cc deployment.

> Every claim marked **verified** was reproduced against real Docker, most of it
> against `ghcr.io/darrendignam/opf-cloud-viper:2.0.0-alpha`. Commands and
> outputs are in section 6.

---

## 1. Where to pick up

```
git branch --show-current   # v2.1.0-container-images
git log --oneline -1        # fad842c feat(auth): withdraw desktop tokens on logout
git log --oneline -3        # the 2.1 work, committed
```

Verification at the point of stopping:

| Check | Result |
|---|---|
| `npx tsc --noEmit` | clean |
| `npx eslint src --ext .ts` | 0 errors, 544 warnings (all `no-explicit-any`, pre-existing) |
| `npx jest` | 795 passed, 49 suites |
| `npx jest` with `src/.env` moved aside | 795 passed (CI parity) |
| `npx gulp` | clean |

Committed as two changes plus a standalone test fix. Teams and the image pool
could not be split cleanly: Team carries the team default image, so the models
depend on each other and either half alone fails to associate.

---

## 2. The findings that changed the design

These are the reason the implementation looks the way it does. Each one was
found by testing rather than by reading documentation, and each one would have
shipped as a bug if assumed the other way.

### 2.1 `docker commit` captures the container's environment

**Verified.** The environment holds `SELKIES_MASTER_TOKEN`, which mints desktop
access through the container's control plane. A naive commit bakes it into the
image config:

```
["SELKIES_MASTER_TOKEN=super-secret-token-abc123","TITLE=ViPER",...]
```

For an image that is only ever launched by CloudViPER this is inert, because
CloudViPER passes a fresh token on every launch and the image's value is
overridden. It stops being inert the moment such an image is pushed to a public
registry, where anyone can read the config.

### 2.2 A filtered `Env` on commit does not remove it

**Verified, and this is the surprising one.** Supplying a filtered `Env` in the
commit options looks like it works and does not:

```js
const kept = info.Config.Env.filter(e => !e.startsWith('SELKIES_MASTER_TOKEN='));
await c.commit({ repo: 'probe', tag: 'clean', Env: kept });
// -> ["TITLE=ViPER","PUID=1000","PATH=...","SELKIES_MASTER_TOKEN=super-secret"]
```

The daemon applies the supplied config and then merges the container's own
environment back over it. The token reappears at the end of the list. Anyone
reviewing that code would reasonably believe it was stripping the secret.

### 2.3 `changes` is the only lever, and it must be a **string**

**Verified.** A `changes` directive does replace the value. But dockerode
JSON-encodes an array into the query string, and the daemon rejects it:

```js
changes: ['ENV SELKIES_MASTER_TOKEN=...']
// -> (HTTP code 400) unexpected - ["ENV is not a valid change command
```

```js
changes: 'ENV SELKIES_MASTER_TOKEN=neutralised-by-cloudviper'
// -> works; real token gone; 0 occurrences in docker history
```

The array form is the more natural thing to write and fails only at runtime, so
there is a test pinning the type:

```
should pass changes as a string, not an array
```

The value is deliberately not empty. An empty `SELKIES_MASTER_TOKEN` risks
Selkies treating it as unset and starting without secure mode, which is worse
than a stale one.

### 2.4 `/config` is the user's home directory, `/defaults` is the image's

**Verified** by reading `init-selkies-config` and `init-adduser` inside the
image. The image seeds a fresh `/config` from `/defaults` on first run:

```bash
CONF_DIR="$HOME/.config/openbox"       # or .config/labwc under Wayland
if [[ ! -f "$CONF_DIR/autostart" ]]; then cp "$DEF_AUTOSTART" "$CONF_DIR/autostart"; fi
if [[ ! -f "$CONF_DIR/menu.xml" ]];  then cp "$DEF_MENU" "$CONF_DIR/menu.xml"; fi
```

This is what makes the "always reset `/config` on commit" decision workable
rather than crippling. Wiping `/config` would otherwise throw away the desktop
customisation an admin just made. Because the image seeds from `/defaults`,
customisation that should reach *everyone* can be promoted there first and
survives the wipe.

The promote mapping in `ContainerImageService` mirrors those seeding paths
exactly. If the image's init changes, the mapping must change with it, or a
promoted desktop will silently fail to appear.

### 2.5 The `'none'` sentinel had spread further than the database

`User.team` was free text where `'none'` meant "no team". That is what allowed
the v2.0 bug where two teamless users could reach each other's desktops. Moving
to a nullable `teamId` removes the class of bug, because SQL will not match NULL
against NULL. But the sentinel had leaked into three other layers, and none of
them were visible to the compiler:

- **Views:** `const userTeam = '{{{user.team}}}' || 'none';`. A null team renders
  as the empty string, so `|| 'none'` *manufactured* the sentinel the database no
  longer had.
- **The users component:** `canEditUser` compared `user.team === userTeam`. With
  both null that is `true`, offering edit controls over every teamless account in
  the system. The server refuses the edits, so this was affordance rather than
  access, but it is the same mistake one layer up.
- **The wire format:** the UI sends the literal `'none'`. Resolving that as an
  ordinary team name would have created a team genuinely called "none" whose
  members all compare equal, reintroducing the sentinel as a real row.

All three are fixed, and the third has its own test file
(`team-resolution.test.ts`) asserting `'none'`, `'None'`, `''` and `'   '` all
mean no team.

---

## 3. What was built

### 3.1 Teams are rows

`Team` model with `name` (unique) and `defaultImageId`. `User.team` (string)
became `User.teamId` (nullable FK). NULL means no team; there is no sentinel.

The guard this removed, in `resolveAccessibleInstance`:

```ts
// before
const belongsToTeam = (team?: string): boolean => !!team && team !== 'none';
if (owner && belongsToTeam(user.team) && owner.team === user.team) { ... }

// after
if ((user.role === TEAM_ADMIN || user.role === TEAM_LEADER) && user.teamId) {
    if (owner && owner.teamId === user.teamId) { ... }
}
```

The wire format still speaks team **names**, because a name is how a person
identifies a team. `resolveTeamIdFromName` is the single seam that translates.

### 3.2 The resolution chain

```
explicit choice  ->  team default  ->  global default  ->  VIPER_IMAGE env  ->  built-in
```

`VIPER_IMAGE` is retained as the bottom rung, so an installation that never
touches the pool behaves exactly as it did before.

A broken **default** is skipped rather than fatal: an image that failed to pull,
or one that has since been blocklisted, must not stop anyone launching a
desktop. An explicit **choice** fails loudly, because quietly handing someone a
different image than the one they picked is worse than telling them no.

### 3.3 The blocklist, and what it is really for

The pool is the allowlist. Nothing reaches a launch screen that an administrator
did not deliberately add, which dissolves most of the "how do we stop them
picking MySQL" problem.

The blocklist matters far more for **deletion** than for selection. Choosing the
MySQL image as a desktop only breaks that instance. *Deleting* the MySQL or
CloudViPER image off the appliance takes the whole platform down. Removal
therefore refuses blocklisted images outright, independently of anything else.

Built-in entries cover the app itself, MySQL, MariaDB, the proxy and the ACME
companion. `IMAGE_BLOCKLIST` adds to them.

### 3.4 Build instances

Admin-only instances that skip `removeSudoAccess`, so an admin can install and
configure things before committing. Recorded on the row as `isBuildInstance`
rather than inferred. Two tests hold the line in both directions:

```
should keep sudo in a build instance
should strip sudo from an ordinary instance
```

The second is the v2.0 hardening. If it ever starts passing for the wrong
reason, every user has root inside their own container.

### 3.5 The commit flow

Order matters and is enforced by test:

1. **Promote** (optional): copy the builder's desktop config into `/defaults`.
2. **Reset `/config`**: wipe the builder's home directory, dotfiles included.
3. **Commit**, neutralising `SELKIES_MASTER_TOKEN` via `changes`.

If step 2 fails, step 3 does not run. Committing anyway would ship the builder's
home directory to everyone the image is launched for.

---

## 4. Open decisions for the morning

1. **Commit splitting.** Team refactor, image pool, flaky-test fix. Probably
   three commits. Not yet done.
2. **Committing resets the source instance's own desktop.** `/config` has to be
   wiped before the snapshot, so saving an image degrades the build instance it
   came from. Build instances are disposable by design so this is defensible,
   but the UI copy does not say so yet and should.
3. **Disk.** A ViPER image is ~6.4 GB. The pool page shows per-image size but
   there is no cap and no total. A Hetzner box will fill.
4. **Phase 5, push to a registry.** Deferred by your choice of local-only. The
   model carries the fields for it, so it is additive.
5. **`/images` is mounted but nothing links to it.** No navigation entry yet.

---

## 5. What is deliberately not done

- **Phase 5**, registry push. Your call: local to the appliance for 2.1.
- **Team-private images.** The pool is global; teams choose a default from it.
  Nobody asked for per-team visibility and it would complicate the allowlist.
- **A migration tool.** Your call: one customer on the 1.x path, so the schema
  was designed for what is right rather than for what migrates easily. Sequelize
  runs with `alter: true`, which adds the columns but does **not** backfill
  `User.team` into `Team` rows. A fresh database is fine; an existing one needs
  a backfill script that does not exist yet.

---

## 6. Reproductions

### Commit captures the environment

```bash
docker run -d --name probe -e SELKIES_MASTER_TOKEN=super-secret-token-abc123 \
  -e TITLE=ViPER alpine:3.19 sleep 60
docker commit probe probe:test
docker image inspect probe:test --format '{{json .Config.Env}}'
# ["SELKIES_MASTER_TOKEN=super-secret-token-abc123","TITLE=ViPER","PATH=..."]
```

### A filtered Env does not strip it

```js
const info = await c.inspect();
const kept = info.Config.Env.filter(e => !e.startsWith('SELKIES_MASTER_TOKEN='));
await c.commit({ repo: 'probe2', tag: 'clean', Env: kept });
// -> token present: true
```

### `changes` as a string does strip it

```js
await c.commit({
  repo: 'probe3', tag: 'neutralised',
  changes: 'ENV SELKIES_MASTER_TOKEN=neutralised-by-cloudviper'
});
// Env: ["SELKIES_MASTER_TOKEN=neutralised-by-cloudviper","TITLE=ViPER","PATH=..."]
// real token present: false
// docker history --no-trunc | grep super-secret -> 0 occurrences
```

### Full flow against the real ViPER image

Set up a builder container with private files and a customised desktop, then run
the exact promote, reset and commit the service performs:

```
promote: exit 0
reset:   exit 0
commit:  done
token neutralised: true
real token gone   : true
other env kept    : true
size (GB)         : 6.36
```

Inspecting the committed image:

```
/config contents:            (empty)
secret-notes.txt:            gone
.bash_history:               gone
/defaults/autostart:         # customised autostart
/defaults/menu.xml:          <menu>custom</menu>
```

The builder's private files are gone and their desktop customisation survived,
which is the split the `/config` reset decision requires.

---

## 7. Files

New:

```
web-app/src/models/containerimage.ts                        151
web-app/src/models/team.ts                                   63
web-app/src/services/ContainerImageService.ts               600
web-app/src/routes/images.ts                                303
web-app/src/views/images_index.handlebars                   253
web-app/src/test/unit/services/ContainerImageService.test.ts 273
web-app/src/test/unit/services/containerImagePool.test.ts   360
web-app/src/test/unit/services/buildInstance.test.ts        139
web-app/src/test/integration/routes/images.test.ts          270
web-app/src/test/integration/routes/team-resolution.test.ts 148
```

Modified: 26 files, chiefly `models/user.ts`, `models/viperinstance.ts`,
`models/index.ts`, `routes/account.ts`, `routes/service.ts`,
`services/ViperInstanceService.ts`, `services/ContainerService.ts`, `app.ts`,
five views and eleven test files.

Unrelated fix carried along: `portManager.test.ts` bound hardcoded port 4000 and
did not await `close()`, hanging the whole suite for its 30 second timeout
whenever anything else held that port. Same hazard as the `isPortAvailable` flake
fixed in v2.0, one file over.

---

## 8. Related

- [SELKIES_MIGRATION.md](SELKIES_MIGRATION.md) for the token design the commit
  flow has to work around.
- [SELKIES_MASTER_TOKEN_EXPOSURE.md](SELKIES_MASTER_TOKEN_EXPOSURE.md) section
  6a, which is why the token in a committed image matters at all.

---

## 9. Traefik routing, added 2026-09-11

Found while preparing the vipercloud.cc deployment, and it would have stopped
the deploy dead.

Instance routing moved to Traefik on `main` in `bd01f56` (2025-12-02). This line
forked from `main` at `9646153` (2025-10-22), so every bit of the Selkies work
was built on the superseded nginx-proxy base:

```
is bd01f56 an ancestor of our HEAD?   NO - our branch predates it
```

Deployed unchanged, instances would have been created on a network that does not
exist on a Traefik host, with no routing labels and no certificate.

Two things were worth care in the port:

**The Labels block had to merge, not replace.** `bd01f56` introduces `Labels`,
and 2.0 had already added `org.openpreservation.cloudviper.instance`, which
`isCloudViPERInstance` checks before tearing down an orphan container. A naive
port replaces the block and silently disables that guard. There is a test that
fails if the ownership label stops surviving alongside the routing labels;
verified by making the naive change and watching it fail.

**Nothing promotes an instance to active any more.** That used to be the proxy's
`ACME_POST_HOOK` firing once a certificate had been issued for the subdomain.
Traefik serves a wildcard, so no certificate is issued per instance and nothing
calls back. Activation moved into the service, and it re-inspects the container
first rather than promoting on a blind timer: one that died during start would
otherwise be advertised as ready and the launch page would frame a desktop that
was never coming.

### Why Traefik rather than the lighter nginx

Asked directly, and three of the four expected arguments did not survive contact:

- **RAM is not a reason.** Measured on the sister box: Traefik 61 MB against
  nginx-proxy's ~30 MB, on a host where one idle desktop is 480 MB.
- **"Reuse what we have" was not true.** This repo has no nginx stack. The
  ingress network is commented out of the compose file and there is no
  nginx-proxy, docker-gen or acme-companion service anywhere, only orphaned
  `VIRTUAL_HOST` variables with nothing to read them.
- **Effort favours Traefik**, opposite to the intuition: a working stack exists
  on the sister box to copy.
- **Certificates decide it.** Desktops are created at runtime as
  `<uuid>.<domain>`. Per-subdomain HTTP-01 means an ACME round trip on every
  launch, ten to thirty seconds unreachable, against Let's Encrypt's ceiling of
  50 certificates per registered domain per week, which a demo day of spinning
  instances up and down can plausibly exhaust. A wildcard removes the exchange
  entirely.

The team had already reached the same conclusion for the ecosystem host:
`PLAN.md` records "Traefik vs nginx-proxy? **DECIDED: Traefik v3**" and
"Wildcard cert or individual certs? **DECIDED: Wildcard**".
