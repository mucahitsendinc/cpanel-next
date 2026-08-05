# cpanel-next

Deploy Next.js projects to cPanel shared hosting from your terminal — or from a
local web interface.

```bash
npm i -g cpanel-next

cd ~/projects/shop
deploymanager
```

**All you need is your cPanel login.** No WHM, no root, no SSH.

*[Türkçe README](./README.tr.md)*

---

## What it does

You run it inside a project. It detects the framework, lists the domains on your
cPanel account, creates the Node.js application if there isn't one, uploads a
build, installs dependencies and starts the app. Subsequent releases are one
command:

```bash
deploymanager update
```

While the application restarts, visitors get a maintenance page instead of a
server error — and it refreshes itself the moment the site is back.

---

## Why this is harder than it looks

cPanel has an API for some things and none at all for others, and the gaps are
exactly where deployment lives. This tool works around them with three tiers and
falls to the next one on its own:

| Tier | Mechanism | When |
|---|---|---|
| **Token API** | cPanel API token → `:2083/execute/` UAPI | Default. Fast, not fragile. |
| **Session HTTP** | Log in, then plain HTTP with the `cpsess` token | API2 endpoints, CloudLinux |
| **Browser** | Headless Chromium | Only when login itself fails |

The browser is used **only to log in**; everything after that is plain HTTP, so a
cPanel theme change doesn't break the tool. Most users never download Chromium at
all.

### Two Node.js regimes, detected not assumed

- **cPanel Application Manager** (`PassengerApps` UAPI, cPanel 66+) — pure API
- **CloudLinux Node.js Selector** — has *no* API of any kind, so commands run
  through cPanel's own cron

`deploymanager doctor` tells you which one you're on and what works.

### A job queue, because cron is slow

Registering a one-shot cron for every command meant waiting 0-60s before anything
happened — the longest single step of a repeat deploy. Instead a long-lived
listener watches a job directory and picks work up in about two seconds. A
permanent one-line cron only checks that the listener is alive and relaunches it.

Measured on a live CloudLinux account: **4-6s per job, against 0-60s before.**
A full `update` went from ~96s to ~51s.

---

## First run

```bash
deploymanager login
```

1. Server, username and your cPanel password
2. The tool logs in and **creates an API token for itself**
3. You choose a **master password**
4. The token is encrypted with it (scrypt + AES-256-GCM), stored `0600`
5. **Your cPanel password is never written anywhere**

After that the browser never opens; only the master password is asked.

> cPanel API tokens cannot be scoped — the function is literally called
> `create_full_access`. The token can reach everything your account can. That is
> a cPanel limitation, not a choice this tool made. Revoke it any time from
> cPanel → Security → Manage API Tokens.

**Forget the master password and the stored data cannot be opened.** That is
deliberate; a password that is stored protects nothing. There are no complexity
rules — `123` is allowed, the threat model is yours.

---

## Commands

```
deploymanager              deploy the project in this directory
deploymanager update       redeploy a linked project, asks nothing
deploymanager login        connect and create a token
deploymanager logout       remove the saved profile
deploymanager status       domains and applications
deploymanager apps         list Node.js applications
deploymanager rollback     restore a previous release
deploymanager logs         server output of the last run
deploymanager doctor       connectivity and environment check
deploymanager ui           open the local web interface
deploymanager config       default interface and language
deploymanager maintenance  turn the maintenance page on/off
```

Useful flags: `--dry-run`, `--domain`, `--app-root`, `--no-build`,
`--clean-modules`, `--confirm <name>`, `--web` / `--terminal`, `--lang tr|en`,
`-y`, `-v`.

Environment: `CPANEL_NEXT_MASTER_PASSWORD`, `CPANEL_NEXT_PASSWORD`,
`CPANEL_NEXT_TOKEN`, `CPANEL_NEXT_HOST`, `CPANEL_NEXT_USER`, `CPANEL_NEXT_LANG`.

---

## Web interface

```bash
deploymanager ui
```

Manage accounts, domains and applications by clicking: deploy with a live log,
roll back, start/stop/restart, remove, read logs, add and remove cPanel accounts.

If you set the web interface as your default, running `deploymanager` in a
project opens the browser with that project selected and **the terminal waits**.
Close the browser and you're back in the terminal.

Closing is detected by heartbeat rather than `beforeunload`/`sendBeacon` — a
beacon never arrives if the tab crashes, the network drops or the browser
discards it, whereas the absence of a heartbeat is a correct signal every time.
**A running deploy always wins over the exit signal.**

Security is the first thing in that server, not a layer added later:

- Bound to `127.0.0.1` only
- `Host` header validated — **DNS rebinding** is a real attack against localhost
  servers, and a request with an unexpected `Host` is never processed
- Every API call requires a custom header, which structurally eliminates
  cross-origin form/img/script requests (CSRF)
- **Your cPanel token is never sent to the browser**; the server holds it
- The vault re-locks after 15 idle minutes
- Destructive steps require typing the exact folder name, **enforced
  server-side** — calling the endpoint directly doesn't get around it

---

## Lifecycle hooks

Declare commands in `.cpanel-next.json` to run on the server around dependency
installation:

```json
{
  "hooks": {
    "preInstall":  ["cp .env.production .env"],
    "postInstall": ["npx prisma migrate deploy"],
    "postStart":   ["curl -s https://example.com/api/warmup"]
  }
}
```

They run with the application's Node virtualenv first on `PATH`, so `npx` and
`node` resolve to the right versions.

> Hooks need a shell, which means they work on CloudLinux. On stock cPanel there
> is no shell path, so hooks are skipped.

---

## Safety

This tool empties a folder and extracts a package into it. Pick the wrong folder
and a live site is gone. Against that:

1. **Typed confirmation** — destructive steps ask you to type the folder name,
   not `y/N`. Enforced on the server too.
2. **Protected names** — `public_html`, `mail`, `etc`, `logs`, `nodevenv`, any
   dot-directory, and any path that is a document root of one of your domains
   (otherwise your source and `.env` would be publicly readable).
3. **Path traversal is rejected, not sanitised** — stripping characters from
   `../../etc` turns it into a different bug rather than fixing it.
4. **A backup before every overwrite.** If the backup fails, the deploy stops.
5. **Ownership record** — every deploy writes a marker saying which project and
   machine it came from. It is shown before you overwrite, and a folder bound to
   a *different* domain is called out in red.
6. **Environment files never enter the package** — `.env`, `.env.local`,
   `.env.bak-…`, the whole dotenv family, by allow-list rather than pattern
   matching.

---

## Requirements and limits

- Node.js 18.17+ locally
- Next.js App Router or Pages Router
- The build always runs **locally**. CloudLinux caps process memory at 1 GB by
  default and CloudLinux's own documentation notes that `npm build` hits OOM
  there.

Not supported yet:

- `output: 'standalone'` — Next's own docs say it cannot be combined with a
  custom server, and Passenger requires one
- **Next.js 13.4.x is refused** — its router-server opens a second `http.Server`
  and Passenger fails with `http.Server.listen() was called more than once`
  (13.5.6+ is fine)
- Sub-path mounting (`basePath` is baked in at build time)
- Laravel

### Things worth knowing about Passenger

- Passenger does **not** provide `PORT`. It patches `listen()` and binds the app
  to its own Unix socket, so the port value is irrelevant — but `listen()` must
  be called **exactly once**.
- Passenger **cannot load ESM**. If your `package.json` sets `"type": "module"`,
  the startup file is created as `server.cjs`.
- Restarting goes through `tmp/restart.txt`, which is only checked when a request
  arrives — so the tool sends one afterwards.

---

## Status

Verified end to end against a live CloudLinux/cPanel account: login and token
provisioning, domain resolution, packaging, upload, deploy, rollback,
maintenance page, worker queue, hooks, the web interface and its security layers.

The stock cPanel path (`PassengerApps`) has now been exercised against a live
cPanel 11.136 account: `register_application`, `list_applications`,
`edit_application`, `ensure_deps`, `enable_application`, `disable_application`
and `unregister_application` all work, and two defects were found and fixed
that would have broken every stock-cPanel deploy — see below.

**What is still unverified is serving.** The test account runs CloudLinux with
LiteSpeed, where the CloudLinux Selector owns Node.js; a stock Application
Manager registration is accepted by the API but never actually served there.
Confirming that an app registered this way is reachable needs a genuinely
stock cPanel box.

Two places where cPanel's own documentation is wrong, both found by running
against a real server:

- `ensure_deps` takes a **home-relative** `app_path`. The documented example
  (`/home/example/my-app/`) is rejected with `Invalid path`.
- `SubDomain::delsubdomain` exists **only in API2**. No UAPI equivalent is
  present under any name.

---

## Author

**Mücahit Sendinç** — [muco.tr](https://muco.tr)

This tool exists because someone got tired of deploying Next.js to cPanel by
hand and decided the interesting problem was worth solving properly rather than
scripting around. Several of the design decisions here came from his direct
experience running Node applications on CloudLinux at scale:

- The **job queue with a `pgrep` watchdog** was his design. The first attempt at
  it was abandoned on the wrong conclusion that detached processes cannot
  survive on shared hosting; he had a working `setsid` launcher from a previous
  project and said so, the test was redone properly, and he was right. That
  correction is the reason deploys are now four to ten times faster.
- He identified that stopping a CloudLinux Node application **removes the
  Passenger block from the document root**, which explains behaviour that is
  documented nowhere.
- The ownership marker used to block updates to folders it hadn't created. He
  pointed out it was refusing the wrong thing — you shouldn't have to re-adopt
  your own application on every release — and it became a record instead of a
  gate.
- The live log on every action, the remembered application folder, the
  self-upgrading worker: all his calls, all from actually using the thing.

Good tools come from people who use them daily and refuse to accept the rough
edges. This one had that.

## License

MIT © Mücahit Sendinç
