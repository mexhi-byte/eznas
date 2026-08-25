# Security

EzNAS holds credentials that are equivalent to root on your NAS. A TrueNAS API
key can do anything the web interface can, and the optional account password is
stored so that file operations TrueNAS has no API for can run under `sudo`.
Please treat a vulnerability here as you would one in the NAS itself.

## Reporting a vulnerability

**Please do not open a public issue.**

Use GitHub's private reporting — the **Security** tab on this repository, then
*Report a vulnerability*. That opens a private thread visible only to the
maintainers.

Include what you were running (version, bare metal or VM, how you installed),
what you did, and what happened. A proof of concept is welcome but not
required; a clear description of the mechanism is worth more than an exploit.

You should get an acknowledgement within a week. This is a hobby project
maintained by one person — if a fix is going to take longer than that, you will
be told so rather than left waiting.

## What is in scope

- Reading or writing anything on the NAS without a valid session
- Escalating from a `viewer` account to anything an `admin` can do
- Recovering stored credentials — the API key or the `sudo` password — from
  anything short of the encryption key itself
- Cross-site scripting, request forgery, or path traversal out of `/mnt`
- Anything that lets one configured NAS connection reach another

## What is not

- Findings that need an attacker who already has the encryption key, root on
  the host, or an admin session. Those are game over regardless.
- The console being reachable without TLS. It does not terminate TLS itself;
  put it behind something that does.
- Denial of service by asking it to do expensive things a legitimate admin
  could also ask for.

## Things worth knowing before you look

- **Stored credentials are encrypted with AES-256-GCM.** The key is SHA-256 of
  `SESSION_SECRET`. If that is not set, a random one is generated on first run
  and kept in `<data file>.key` with mode `0600`.
- **Versions before 0.5.2 fell back to a fixed key** compiled into the source
  when `SESSION_SECRET` was unset. Anything written by those versions could be
  decrypted by anyone holding the file. On first start, 0.5.2 and later
  re-encrypt such data with the installation's own key — but if a copy of that
  file escaped before you upgraded, **rotate the TrueNAS API key and the
  account password**, because re-encrypting does not un-leak what was taken.
- **The NAS certificate is pinned** by fingerprint on first connect. A
  certificate change is treated as a failure rather than a prompt.
- **The shell is admin-only** and gated on the server, not in the browser.
