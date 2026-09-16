# Roadmap

What 1.0 means, what is done, and what comes after. Issues and pull requests
are welcome against any of it; the labels `phase-N` and `roadmap` mark work
that belongs here.

## What 1.0 means

A person who owns a TrueNAS box and is not a storage administrator can, without
opening TrueNAS's own interface:

1. **Install it from TrueNAS itself** — Apps → Custom App, paste one file — or
   with one command, and be walked from sign-in to a working Home page.
2. **Set up a fresh box** in one sitting: pool, folders, people, shares,
   snapshots, scrub, self-tests.
3. **See whether the data is safe** — snapshots, scrubs, self-tests, copies
   elsewhere — as facts with dates, and fix what is missing from one page.
4. **Do the everyday things**: browse, upload, move and share files; install
   and configure apps and read their logs; add people and groups; restart the
   box.
5. **Trust it**: the NAS certificate pinned by default, the console's own
   backup a button, a stated TrueNAS support window, and a browser test that
   runs the whole first-run flow on every change.

Everything in that list is built and 1.0 is tagged. The two phases marked
"needs hardware" below were released on the maintainer's decision before a run
against a real TrueNAS 25.04 box; a wrong argument shape there is a sentence in
a dialog, and a patch release when reported.

## Done

| Phase | Shipped as | What                                                                                                   |
| ----- | ---------- | ------------------------------------------------------------------------------------------------------ |
| 1     | 0.5.2, 0.6 | First-run password, security headers, forwarded-IP trust, port, naming, power                          |
| 2     | 0.6        | Release workflow, GHCR image, Custom App install, installer pulls, lint, coverage                      |
| 3     | 0.6        | Setup wizard, certificate pinning by default, schema-driven app install                                |
| 4     | 0.6        | Route split, groups, app logs and shell, mock NAS, browser test                                        |
| 5     | 0.7, 1.0   | Backups & checks, Home safety card, encrypted folders, Time Machine, console backup — _needs hardware_ |
| 6     | 0.7, 1.0   | Layout recommendation, fresh-NAS setup, demo, this document — _needs hardware_                         |

## After 1.0

In rough order of leverage.

- **Light theme.** Seven themes, all dark.
- **Internationalisation.** Wrap the strings; Albanian and German first.
- **Accessibility pass.** Focus traps, tablist roles, keyboard for the file
  browser and drive map.
- **Installable on a phone**, with push notifications that need no third party.
- **Audit log.** Who did what to which NAS.
- **Per-account folder scopes**, so a viewer sees only their folders.
- **Command palette.**
- **The console's own HTTPS.**
- **Virtual machines**, read-only first.

## Deliberately not planned

iSCSI, Active Directory, Kerberos, certificate authorities, multi-node
anything. TrueNAS's own interface serves those users well, and saying no to
them is what keeps this console legible.
