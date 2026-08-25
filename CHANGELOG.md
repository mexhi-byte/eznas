# Changelog

What changed in each release, and why it mattered. Newest first.

Versions follow [semantic versioning](https://semver.org/), loosely: the
console is pre-1.0, so a minor bump may still change behaviour you relied on.
Anything that does is called out under **Changed** or **Upgrading**.

## Unreleased

### Security

- **Stored TrueNAS credentials are no longer encrypted with a key published in
  this repository.** The key derived from `SESSION_SECRET` fell back to a fixed
  string in the source when that was unset, so a `connections.json` obtained
  from a backup or a misconfigured share could be decrypted by anyone holding
  a copy of the source. A TrueNAS API key is equivalent to root on the NAS.
  Set `SESSION_SECRET` and it is used; leave it unset and a random one is
  generated on first run and kept at `<data file>.key`, mode `0600`.

### Upgrading

- **Rotate your TrueNAS API key and account password** if a copy of your data
  file may have left your machine while running 0.5.1 or earlier without
  `SESSION_SECRET` set. Data written under the old key is re-encrypted
  automatically on first start — but re-encrypting does not un-leak anything
  already taken.
- **Back up `<data file>.key` alongside the data file.** Without it, stored API
  keys cannot be read. This does not apply if you set `SESSION_SECRET`
  yourself, which `install.sh` has always done.

### Fixed

- Uploads that failed reported only `Upload failed (502)`. The transfer
  rejected with a raw socket error reading `socket hang up`, which the error
  handler matched as "cannot reach the NAS" and sent as a 502 — where a proxy
  may replace the body with its own page and destroy the reason. Upload
  failures are now 4xx, bytes received are checked against the length the
  browser announced, and a 5xx arriving as HTML says the reply did not come
  from the console at all.
- The apps page drew seven controls in a row that could not wrap, so they
  overlapped and the buttons underneath could not be clicked — which is why
  **Details** appeared to do nothing.
- **Details** showed only an error for apps deployed from a compose file, which
  have no catalog entry. It now leads with what the console already knows:
  state, version, containers, and the addresses the app is reachable at.

### Added

- Continuous integration running the typechecks, the test suite and the build
  on every pull request.
- `SECURITY.md`, `CONTRIBUTING.md`, issue and pull request templates.

## 0.5.1

The interfaces for the features 0.5.0 shipped without one. See the note under
0.5.0 — if you installed it and concluded that uploads, search and NFS exports
did not work, they were not reachable, and this is the release that fixes that.

### Added

- **Upload files** by dragging them into a folder or picking them. Serial, with
  per-file progress, transfer rate and cancel. Name clashes ask Replace, Keep
  both or Skip before any bytes move; Keep both splits on the last dot, so
  `archive.tar.gz` becomes `archive.tar (2).gz`.
- **Search for a file** without knowing which folder it is in. The filter box
  gains a second act: at two characters it offers to search the whole pool,
  streaming results as they are found, with Stop.
- **Create NFS exports** from the share dialog. A protocol switch changes which
  question is asked — SMB authenticates people, NFS authenticates machines —
  and an empty machine list is refused rather than exporting to the network.
  Root mapping sits behind Advanced, described by what it costs.
- **Open an app** to see what it is: screenshots, description, publisher,
  source, and how many versions exist to roll back to.
- **Logos and links for apps installed through TrueNAS's own interface.** These
  carry no catalog metadata, so the console matched them by name and derived
  their addresses from the ports they publish.
- **The recycle bin is a folder**, listed where it lives instead of behind a
  toolbar button, and restoring asks where: back where it came from, under a
  new name, or into a folder you name.

### Security

- A catalog app's home page, sources and maintainer links were rendered
  straight into `href`. A `javascript:` URL among them — that data is written
  by whoever published the chart — would run in the console's own origin on
  click. Only `http(s)` is accepted now, checked at the mapper and again in the
  component.

## 0.5.0

**Known issue, fixed in 0.5.1:** the release notes listed file uploads, search
and NFS exports. All three shipped a server route, a tested client helper and a
green test suite — and none of them had a caller in any component, so from the
browser they did not exist. `test/feature-wiring.test.ts` was added afterwards
so that a feature cannot ship unreachable again.

### Added

- **A verdict for every drive on the map** — the same `ok`/`warn`/`bad`
  judgement the health dialog shows, computed from ZFS status, error counters,
  failed self-tests and temperature, rather than colouring tiles by vdev status
  alone. ZFS reports `ONLINE` for a drive logging checksum errors.
- **An honest answer when a drive reports no temperature.** Virtual disks
  return exactly 0°C, which the console refuses to believe, and the tile was
  left blank — indistinguishable from a bug. It now says so, and a failure to
  read temperatures at all is reported rather than swallowed.
- A **Dockerfile** and `install.sh`, which installs under `/mnt/<pool>/eznas`
  so it survives TrueNAS updates.
- **Notification when a new console release exists.**
- The first **test suite** — this project had none.

### Security

- **The shell WebSocket refuses anyone who is not an admin.** A `viewer`
  account could previously reach a root shell on the NAS. The gate is enforced
  on the server; the Terminal tab is also hidden from viewers, but the hiding
  is cosmetic and the refusal is the fix.
- **The certificate pin is checked before anything is sent**, not after.

### Changed

- The file browser and the file routes moved into their own modules;
  `server/index.ts` had grown past the point where its shape was legible.

## 0.4

First public build. Home, drive array map, storage and snapshots, the file
browser, sharing, apps with configuration and recovered passwords,
notifications, four themes, 2FA, a web terminal, and network configuration with
a rollback countdown.
