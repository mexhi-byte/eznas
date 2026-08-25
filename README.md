# EzNAS

A beautifully simplified, open-source web UI for TrueNAS. Built for homelabs, powered by WebSockets.

TrueNAS ships an interface built for storage administrators. This is one built for the person who
owns the box: pools you can read at a glance, apps as icons rather than a count, a file browser that
can actually move and delete things, and notifications for the situations TrueNAS stays quiet about.

**v0.5 — early.** Used daily against real hardware, and still young enough that you should read
[Security](#security) before putting it anywhere the internet can reach.

[Changelog](CHANGELOG.md) · [Contributing](CONTRIBUTING.md) · [Reporting a vulnerability](SECURITY.md)

---

## What it does

**Home** — one screen answering "is it fine, and what do I want to do". Overall capacity, pool cards
with nicknames you choose, plain-language health ("Mostly file cache, which is exactly right"), your
apps as a logo grid, and three quick actions: share a folder, install an app, check the drives.

**Drive array map** — every physical drive drawn in its vdev, colour-coded, each explaining what its
layout buys you ("2 copies of everything. Survives 1 drive failing"). Click a drive for its health:
ZFS error counters, throughput, SMART attributes and self-tests, with a verdict in words first. Each
tile carries that same verdict, so a drive logging checksum errors is not green merely because ZFS
still calls it `ONLINE` — and a drive that reports no temperature says so rather than showing a gap.

**Storage** — pools, datasets, and snapshots you can actually take: create, clone, roll back, hold,
copy to another pool, and scheduled snapshots with retention.

**Files** — browse, preview images, video, audio, PDFs and text, create folders, rename, drag items
between folders, and set who can use a folder. **Upload** by dragging files in, with progress, a
transfer rate and cancel; a name that already exists asks before anything is overwritten. **Search**
the whole pool for a file when you cannot remember which folder it is in, streaming results as they
are found. Deleted items go to a per-pool **recycle bin**, which is a folder in the listing rather
than a button, and putting something back asks where: its original place, a new name, or a folder
you choose.

**Sharing** — put a folder on the network and say who may use it, in one step. The share and the
filesystem ACL are set together, because a share without permissions appears on the network and then
refuses everybody. Windows and Mac get **SMB**, which authenticates people; Linux and Unix get
**NFS**, which authenticates machines — so the dialog asks a different question depending on which,
and refuses to create an export that would be open to every device on your network.

**Apps** — start, stop, update, open, and edit configuration: a real form built from a catalog app's
own schema, or the compose file for a custom app. Open any app for its screenshots, description,
publisher and source. Apps deployed through TrueNAS's own "Custom App" button carry no catalog
metadata, so the console finds their logo by name and works out where to reach them from the ports
they publish. Plus a **Passwords** panel that digs out the credentials an app generated at install
and never showed you again.

**Notifications** — the console runs its own checks every minute: pool health, capacity against a
threshold you set, drive temperature, ZFS read/write/checksum errors, apps stopping on their own,
scrub results, updates, and the NAS not answering. A standing condition is reported once, not once a
minute, and clears when it resolves.

**Also** — four themes, per-account 2FA, a web terminal, network configuration with a rollback
countdown, and SMTP.

## Requirements

- TrueNAS SCALE 25.04 or newer (it speaks JSON-RPC at `/api/current`, not the deprecated REST API)
- Node.js 22+
- An API key from TrueNAS → Credentials → Local Users → API keys

## Install

**On the NAS itself**, which is what most people want. This installs under
`/mnt/<pool>/eznas` so it survives a TrueNAS update, generates a `SESSION_SECRET` once, and runs in
a container:

```bash
curl -fsSL https://raw.githubusercontent.com/mexhi-byte/eznas/main/install.sh | sh
```

Re-running it updates an existing install in place.

**From source**, for development or if you would rather not pipe a script into a shell:

```bash
git clone https://github.com/mexhi-byte/eznas.git
cd eznas
npm ci
cp .env.example .env    # then edit it
npm run build
npm start
```

Then open the console, sign in with the username and password from `.env`, and add your NAS under
Settings → Servers.

Run it under systemd for anything permanent:

```ini
[Unit]
Description=EzNAS console
After=network-online.target

[Service]
WorkingDirectory=/opt/eznas
EnvironmentFile=/opt/eznas/.env
ExecStart=/usr/bin/node dist/server/index.js
Restart=always

[Install]
WantedBy=multi-user.target
```

## Security

Read this part.

- **The console holds an API key with full control of the NAS.** Anyone who can reach it and sign in
  can do anything to your storage. Put it behind a VPN or an identity proxy; do not expose it to the
  internet on a password alone.
- **Console accounts are not NAS accounts.** They are local to this app, scrypt-hashed in
  `data/accounts.json`, with roles of `admin` or `viewer`. The viewer role is enforced at the API,
  not by hiding buttons — every non-`GET` request from a viewer is refused.
- **A viewer can still read every file** through the browser, because the console acts with the NAS's
  API key regardless of who is signed in. Folder permissions govern SMB, NFS and apps — not what the
  console itself can see.
- **The optional stored NAS password** is only needed for move, rename and delete, because TrueNAS's
  API has no call for any of them and they have to run as shell commands. It is AES-256-GCM encrypted
  at rest, never returned to the browser, and never reaches the shell's output or history. Leave it
  unset and the file browser stays read-only.
- **`SESSION_SECRET` is the encryption key** for stored credentials, derived by SHA-256. Set it with
  `openssl rand -hex 32` and treat it as a secret; changing it invalidates every session and every
  stored API key. If you do not set one, a random key is generated on first run and kept beside the
  data file as `<data file>.key` with mode `0600` — **back that up with your data, because without
  it the stored API keys cannot be read.**
- **Versions before 0.5.2 used a fixed key from the source** when `SESSION_SECRET` was unset, which
  means anything they wrote could be decrypted by anyone holding the file and a copy of this
  repository. Such data is re-encrypted automatically on first start. If a copy of your data file
  may already have left your machine, **rotate the TrueNAS API key and the account password** —
  re-encrypting does not un-leak what was taken.
- **Certificate pinning** is available per server and is the only way this connection is
  authenticated, since TrueNAS uses a self-signed certificate. Without it the API key travels over a
  link nothing has verified.
- **Destructive actions require typing the name** of what is about to be lost, and the API enforces
  that too — a mis-aimed script fails instead of succeeding on the wrong pool.

## How it talks to TrueNAS

Everything goes over JSON-RPC 2.0 on `wss://…/api/current` — the same interface TrueNAS's own UI
uses, and the only one that survives the removal of the REST API in 25.10. The live figures on Home
are a `core.subscribe` push about once a second, not a poll.

A few things have no API at all on 25.04: **moving, renaming, copying and deleting files**. Those go
through the NAS's shell WebSocket, quoted and confined to `/mnt`. See `server/nas-exec.ts` for what
that costs and how it is contained.

## Updating

Settings → App updates checks this repository's releases, shows what changed, and can install one in
place. It saves the current build as `dist.prev` first and never touches `data/`.

## Layout

```
server/     Node API. truenas.ts is the JSON-RPC client; index.ts is what is left
            of the routes, which are moving out of it a module at a time.
  routes/        the routes that have moved: files, shares
  http.ts        helpers every route needs, and the one place both sides may import
  accounts.ts    console users, scrypt hashes, roles
  secret.ts      the key stored credentials are encrypted with
  monitors.ts    the checks that generate notifications
  nas-exec.ts    shell commands, for what the API cannot do
  self-update.ts release checking and in-place update
web/        React front end, no framework beyond it.
test/       vitest. Pure logic directly, routes against a NAS that records
            what it was asked to do.
data/       Runtime state. Not in git, and not touched by updates.
```

A route module must never import from `server/index.ts`: it starts the server at module scope, so
importing it from something it imports resolves to a half-initialised object. Shared helpers live in
`server/http.ts` for that reason.

## Contributing

Bug reports and pull requests are welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how the
project is put together and what it is trying to be. Two things worth knowing before you start: a
feature is not finished when its endpoint works, only when someone can reach it from the browser;
and errors here are meant to be sentences, not codes.

Security issues go through the Security tab rather than a public issue. See
[SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE).
