# cpanel-next

Deploy Next.js and Laravel projects to cPanel shared hosting from your terminal
— or from a local web interface.

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
5. **Your cPanel password is not written anywhere** unless you turn on auto
   login for that account (see below) — and then only encrypted in the vault

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
deploymanager db           MySQL databases (list, create, drop, users, pma)
```

Useful flags: `--dry-run`, `--domain`, `--app-root`, `--no-build`,
`--clean-modules`, `--confirm <name>`, `--web` / `--terminal`, `--lang tr|en`,
`--env-local`, `-y`, `-v`.

Environment: `CPANEL_NEXT_MASTER_PASSWORD`, `CPANEL_NEXT_PASSWORD`,
`CPANEL_NEXT_TOKEN`, `CPANEL_NEXT_HOST`, `CPANEL_NEXT_USER`, `CPANEL_NEXT_LANG`.

---

## Web interface

```bash
deploymanager ui
```

Manage accounts, domains and applications by clicking: deploy with a live log,
roll back, start/stop/restart, remove, read logs, add and remove cPanel accounts.

It is built to be understood at first glance, without prior cPanel or Node
knowledge:

- A **welcome screen** on first run explains what the tool does in three steps,
  then asks for one account. (Previously a first-time user hit the vault-unlock
  screen, typed a password and got `no profiles` — a door with nothing behind
  it and no way past.)
- Deploying is a **three-step flow** — project → target → review — with a
  progress strip, so you always know where you are and what is left.
- Every field carries a one-line explanation, every empty list says what it
  means and what to do next, and the review step spells out what will be
  deleted *and what will be kept*.
- Applications are cards, not table rows: status, address, folder and every
  action in one place.
- **phpMyAdmin**, **File Manager** and **cPanel** open in one click, for the
  account or for a specific application folder.
- Accounts can be **edited**: server, port, username, and token renewal — with a
  **"Test connection"** button next to each. "Is my token still valid?" gets
  answered here, not halfway through a deploy.

### Auto login

Those links **sign in to cPanel for you** and land directly on the target. That
requires storing your cPanel password; it is on by default when you add an
account and can be turned off with one click.

Why a password is needed: cPanel's web interface authenticates with a
`cpsession` cookie, not an API token, and that cookie has to live in *your*
browser. cPanel's own specification says of `Session::create_temp_user`:
*"Because this function requires a valid cPanel session ID… You **must** use the
WHM API 1 `create_user_session` function"*. WHM is out of scope for this tool, so
there is no way to mint a browser session from a token.

When stored, the password sits in the **same vault** as the token: AES-256-GCM
under a key derived from your master password with scrypt, in a `0600` file. At
sign-in time the local server renders a single `no-store` page whose
`form-action` policy allows **only** that cPanel origin, and the form removes
itself from the DOM after submitting. The password travels from your browser to
cPanel and nowhere else; the API token never appears on that page.

With it off, the links go to cPanel's login page with `goto_uri`: you type your
password into cPanel and still land on the right screen.

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

## Email, FTP and backups

Deploying alone is not enough: once a site is live it needs mailboxes, file
access and backups. In cPanel these are separate screens; here they are in the
same interface.

### Email

Create, delete, rotate passwords and set quotas. **Connection settings are read
from the server**, not guessed — hosts change the server name and ports, and a
wrong `mail.domain.com:465` costs people hours. The screen shows both the
secure (SSL/TLS) and plain values, with IMAP, POP3 and SMTP ports.

Deleting a mailbox requires typing the address exactly: every message in it
goes too.

### FTP

Create, list, rotate passwords, delete. The login name is given ready as
`user@server`.

Two notes:

- **Dots are preserved.** cPanel's `disallowdot` defaults to `1`, so
  `deploy.bot` silently becomes `deploybot` and the user cannot connect without
  knowing why. We send `0` explicitly.
- **Deleting does not delete files.** cPanel's `destroy` parameter also removes
  the account's home directory, and the default home directory can be the
  application itself — so removing an FTP account could take the site down.
  That parameter is never sent.

### Back up and download

Every database has a button: it is exported on the server and downloaded to
your computer. Application cards have the same thing for files.

```
~/Downloads/cpanel-next/shop-20260806143000.sql.gz
```

The moment it lands, a **"Show in folder"** button appears — it does not open
the file, it reveals it in Finder.

How it works, because it is less simple than it looks:

- cPanel's UAPI has **no download endpoint**. `Fileman::get_file_content`
  exists but supports no ranges and returns JSON, so it corrupts binaries; the
  classic `/download?file=…` needs a session cookie and rejects tokens. So the
  file is base64-encoded and split on the server, the parts are read one by one
  and reassembled locally — the mirror image of uploading. The size is compared
  at the end: a partially downloaded file is never silently accepted.
- A database needs `mysqldump`, but **we do not have any existing user's
  password**. A short-lived MySQL user is created and deleted the moment the
  job ends — including on failure. The password is **never** put on the command
  line: `mysqldump -pPASSWORD` is visible to everyone in `ps` on shared
  hosting. A temporary 0600 `--defaults-extra-file` is used instead.
- Above 200 MB the tool stops and points you at cPanel's own download screen:
  this path is one HTTP round trip per chunk and takes minutes at that size.
  Saying so beats trying silently.

### Changing your cPanel password

In Settings. cPanel **requires the current password**, and that is right: an
interface with an unlocked vault should not be able to change your cPanel
password without your consent. If auto login is on, the copy in the vault is
updated too.

> The `enablemysql` flag is **not sent**. cPanel uses it to sync MySQL user
> passwords with the account password — which instantly invalidates
> `DB_PASSWORD` in every `.env` and takes every live application off its
> database. Not something to do silently.

### The master password

Change it in Settings → General. Every secret in the vault (tokens and, if auto
login is on, cPanel passwords) is re-sealed with the new key.

The file is written **once**: a failure midway would leave a vault half
encrypted with the old key and half with the new one, and that vault could
never be opened again. If the current password is wrong, nothing is touched.

### Where settings live

Two different scopes, two different places:

| | where |
|---|---|
| Language, default interface, **master password** | Settings tab |
| Connection, token renewal, **cPanel password**, auto login, removing the account | the ⚙ next to the account picker in the header |
| A new cPanel account | the **+** in the header |

---

## Desktop app

```bash
cd desktop
npm install
npm start          # development
npm run build:mac  # produces a .dmg (win / linux available too)
```

A double-clickable build that lives in your Applications folder. No terminal
needed.

**It has no logic of its own, and should not.** `deploymanager ui` already
started a server on 127.0.0.1 and pointed the browser at it; the desktop build
starts that same server inside Electron's main process and shows it in a
window. The interface, the APIs and the security layers are identical — `lib/`
stays the single source, because two diverging front-ends would mean a fix in
one never reaching the other.

The shell makes four decisions of its own:

- **The page stays a web page.** `nodeIntegration` off, `contextIsolation` and
  `sandbox` on. The interface already talks to the server over its HTTP API and
  that API requires a session token; skipping that layer just because we are
  now a desktop app would open an attack surface the browser build does not
  have.
- **External links open in the system browser** — phpMyAdmin, File Manager,
  cPanel, the deployed site itself. The user's cPanel session lives in their
  real browser, and turning the app into a browser with no way back would be
  worse.
- **There is a menu**, because without one Cmd+C / Cmd+V simply do not work in
  Electron. In a tool where you copy passwords and connection strings that
  would be a quiet but maddening defect.
- **Closing the window quits the app**, even on macOS. A server holding a cPanel
  token runs in the background; a process the user cannot see should not keep
  it in memory.

> An unsigned app trips Gatekeeper on macOS: the first launch needs right-click
> → Open. Proper distribution needs an Apple Developer account and
> notarization — the code side is ready, the signing is done with your account.

The desktop package is **not** part of the npm package: the `files` field only
collects `bin`, `lib` and the READMEs.

---

## Laravel

```bash
cd ~/projects/shop
deploymanager            # first install
deploymanager update     # every release after that
```

### The document root is never changed

The "clean" answer to Laravel's `public/` problem is `SubDomain::changedocroot`,
pointing the document root at `<folder>/public`. This tool does not use it: it
is impossible on a primary domain (that needs WHM), and on an addon/subdomain it
permanently rewrites the account's configuration.

Instead Laravel is installed **into the domain's own folder** and `.htaccess`
does the work:

```
~/shop.example.com/          ← document root (untouched)
  .htaccess                  ← sends every request into public/
  app/ config/ vendor/ .env  ← unreachable by URL because of that rewrite
  public/                    ← Laravel's own .htaccess takes over here
```

The application folder is therefore **not asked for** — it *is* the document
root. Deploying into the wrong folder is structurally impossible.

> This layout has a cost: the source files physically live under a web-served
> directory. `AllowOverride None`, or mod_rewrite being off, exposes your `.env`
> to the internet. So after deploying, the tool **actually fetches**
> `https://domain/.env`, `/composer.json` and `/artisan` and fails loudly if any
> of them is readable.

### Code is wiped, data is kept

Two opposite requirements that one rule cannot satisfy:

- A file you **deleted locally** must not survive on the server. Overwriting
  alone would leave a deleted controller alive and still routable.
- A file **generated on the server** must not be deleted: `public/uploads`,
  `storage/logs`, invoices, user images.

| | behaviour |
|---|---|
| `app` `config` `routes` `database` `resources` `bootstrap` `vendor` | **deleted and reinstalled** |
| `storage` | never packaged, never deleted |
| `public` | package extracted over it; **not deleted** |
| `.env` `.htaccess` `.well-known` `cgi-bin` `.user.ini` | untouched |

Stale files under `public/` are handled by a **manifest**: every deploy records
the list of public paths it shipped in the ownership marker. The next deploy
deletes exactly those paths that *we* shipped last time and are not shipping
now. A file we never shipped is not in the list, so it can never be deleted —
that is set arithmetic, not a promise.

### `.env`

Your local `.env` is **never uploaded**, and no line of the server's file is
removed. Only these are written:

- `APP_DEBUG` is set to `false` when it is `true` (disable with `--keep-debug`)
- `APP_URL` on first install, from the domain you picked
- `DB_*` if you chose a database

If the server has no `.env` at all it is created from `.env.example` and an
`APP_KEY` is generated.

### vendor and node packages

`node_modules` **never travels**: the Vite/Mix build runs locally and only the
`public/build` output ships.

`vendor` has three modes, `auto` by default:

| mode | behaviour |
|---|---|
| `auto` | ship only when `composer.lock` **changed**; otherwise the server's copy is kept (~2 MB updates) |
| `always` | ship on every deploy |
| `server` | do not ship; run `composer install --no-dev -o` on the server |

`server` is not the default: composer is memory hungry and OOM under
CloudLinux's default 1 GB LVE limit is a real outcome.

### Permissions

Set from the shell on the server during install:

| | |
|---|---|
| Directories | `755` |
| Files | `644` |
| `storage`, `bootstrap/cache` | `775` |
| `.env` | `600` |

Why it is needed: a zip carries its own mode bits and those depend on the umask
on *your* machine. A file extracted as `600` on the server cannot be read by
the web server and the site returns 403.

The document root itself is set to `755` — Apache **suEXEC** refuses to serve a
group- or world-writable document root, so leaving it at `775` would take the
site down with a 500.

`.env` at `600` is a second line of defence: in this topology the file sits
under the document root and `.htaccess` hides it — but we do not rely on a
single defence.

### Migrations

| | default |
|---|---|
| first install | `migrate:fresh --seed` |
| update | `migrate --force` |

Modes: `none`, `migrate`, `migrate-seed`, `fresh-seed` — via flags
(`--migrate none`, `--no-migrate`) or `.cpanel-next.json`:

```json
{
  "framework": "laravel",
  "laravel": {
    "migrate": "none",
    "firstMigrate": "fresh-seed",
    "vendor": "auto",
    "forceDebugOff": true,
    "optimize": true
  }
}
```

> `migrate:fresh` **drops every table**. It is printed in red on the review
> screen and is never the default for an update.

After install, in order: write permissions → `storage:link` → migration →
`optimize:clear` → `config:cache` → `route:cache` → `view:cache`. The last two
are non-fatal — `route:cache` fails on closure routes, and that should not stop
a release.

### Worth knowing

- If the document root is not empty (a live WordPress, a plain HTML site) you
  must **type the folder name** to confirm, and a backup is taken first.
- `composer.lock` is **required**. Without it the vendor decision cannot be made
  and server versions can drift from local — on the Next.js side that exact
  drift produced a crash inside the framework.
- The domain's PHP version is read from cPanel (`LangPHP`) and artisan runs with
  it, so Laravel 11 finds PHP 8.2+ even when the account's default CLI is 7.4.

---

## Databases

Deploying an application without a database is half a job. In cPanel, wiring
one up takes four screens — *Create Database*, *Create User*, *Add User To
Database*, the privilege checkboxes — and then you assemble the connection
string by hand.

```bash
deploymanager db create shop --app-root shopnext --env-local
```

That single command creates the database, creates a user, grants it full
privileges on that database, generates a password, and writes

```
DATABASE_URL=mysql://shop_user:…@127.0.0.1:3306/user_shop
```

into `.env` on the server **and** `.env.local` on your machine. The web
interface does the same with one button, plus a **phpMyAdmin** link for the
account or for a single database.

```
deploymanager db              list databases, sizes and users
deploymanager db create <n>   database + user + privileges + DATABASE_URL
deploymanager db drop <n>     drop a database (typed confirmation)
deploymanager db users        MySQL users and what they can reach
deploymanager db pma [n]      open phpMyAdmin
```

Notes worth knowing:

- **The prefix is asked for, not assumed.** Most hosts force `<account>_` in
  front of every database and user name, but a host can turn prefixing off, in
  which case cPanel returns `prefix: null`. Treating that as "no answer" and
  prepending `<account>_` anyway would create names the user cannot find in
  cPanel. `Mysql::get_restrictions` is the authority.
- **The password is shown once.** It is not stored — not by cPanel, not by
  this tool. That is why the same screen offers to write it straight into
  `.env`.
- **Existing objects are left alone.** If the database already exists it is not
  touched (it may hold data); if the user already exists its password is *not*
  rotated, because another application may be using it.
- **Dropping asks you to type the name.** A database has no backup and no undo,
  so the rule is stricter than for folders, and it is enforced server-side.
- **phpMyAdmin never sees your password through this tool.** A cPanel session
  cannot be minted from an API token, so the button is a `goto_uri` deep link
  into cPanel's own login. Already logged in? You land in phpMyAdmin directly.

`.env`, `.env.local`, `.env.production` and `.env.production.local` are now
preserved across deploys. They are never packaged, so anything written there
would otherwise be destroyed by the next release.

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
`node` resolve to the right versions — at **all three** stages. A command may
be given as a bare string instead of an array; anything else is reported and
ignored rather than silently iterated character by character.

> Hooks need a shell, which means they work on CloudLinux. On stock cPanel there
> is no shell path, so hooks are skipped — and the deploy log says so, with the
> number of commands that did not run.

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
- Next.js App Router or Pages Router · Laravel 9+ (`artisan` + `composer.lock`)
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

### Build and runtime must be the same version

The package this tool uploads carries a `package.json` whose dependency ranges
are rewritten to the exact versions in your `package-lock.json`. Your own file
is never touched — only the uploaded copy.

This is not a nicety. `"next": "^16.1.1"` means the build runs locally on 16.1.1
and produces a `.next` shaped for it, while `npm install` on the server fetches
16.3.0. Running that build under a different minor crashes **inside the
framework** with `Cannot read properties of undefined` and a stack that says only
`at ignore-listed frames` — no hint anywhere in your own code. Measured on a live
account: built with next 16.1.1 / react 19.2.3, server installed 16.3.0 / 19.2.8.

Uploading `package-lock.json` is not enough; CloudLinux's `install-modules` does
not honour it. This is also why `output: 'standalone'` appears to "fix" such a
project — it embeds the build-time `node_modules`, so no install runs on the
server and no drift is possible.

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
