# Contributing

Thanks for looking. This is a small project with a specific idea of what it is
for, so a note on that before the mechanics.

## What EzNAS is trying to be

A console someone can hand to a person who owns a NAS but is not an
administrator. TrueNAS's own interface is complete and assumes you know what a
vdev is. This one assumes you do not, and tries to make the safe thing the
obvious thing.

Two consequences worth knowing before you write code:

- **A feature is not done when the endpoint works.** It is done when somebody
  can reach it from the browser. Version 0.5.0 shipped file uploads, search and
  NFS exports — each with a route, a tested client helper, and a green suite —
  and none of them had a single caller in any component. `test/feature-wiring.test.ts`
  exists because of that, and new features should extend it.
- **Errors are sentences.** "Say which machines may mount this. An export with
  no restriction is open to every device on the network" beats
  `EINVAL: networks`. If a message would leave someone searching a forum, it is
  not finished.

## Getting it running

```sh
npm install
npm run dev:server     # the API, on :8778
npm run dev:web        # the browser build, on :5173
```

You need a TrueNAS box to point it at. Set `SESSION_SECRET` to anything; without
it one is generated and kept beside the data file.

## Before you open a pull request

```sh
npm test
npx tsc -p tsconfig.json --noEmit
npx tsc -p tsconfig.server.json --noEmit
npm run build
```

CI runs exactly these. Running them first saves a round trip.

## Tests

Write the failing test first. Not as ceremony — as the only way to know the test
can fail at all. A guard was added to this repo asserting a feature was
reachable, and it passed whether the feature was wired up or not, because
`"uploadFileXX".includes("uploadFile")` is `true`. It was only found by
deliberately breaking the thing it guarded and watching it stay green.

**So: break what you are testing and watch the test fail, before you make it
pass.**

Prefer pure functions for anything with rules in it — path handling, name
collisions, validation — and test those directly. Route logic is testable
against a fake NAS object that records what it was asked to do; see
`test/nfs.test.ts` for the pattern. What matters there is often the *order*:
that a bad request reaches the NAS not at all, rather than merely failing.

## Commits

Imperative, sentence case, no `feat:`/`fix:`/`chore:` prefix:

```
Validate an NFS export's machine list before creating it
```

The body explains **why**, and is where the value is. Assume the reader can see
the diff and cannot see your reasoning. If the change fixes something subtle,
say what the old behaviour was and why it was wrong.

Sign off with:

```
Co-Authored-By: <name> <email>
```

## Code

Match what is around you. Some specifics that are not obvious:

- **Server imports use `.js` specifiers from `.ts` sources** (`module: NodeNext`).
- **Route modules never import from `server/index.ts`.** It calls `store.init()`
  and `server.listen()` at module scope, so importing it from a module it
  imports is a cycle resolving to a half-initialised object. Shared helpers live
  in `server/http.ts`.
- **Every path is confined to `/mnt`** via `underMnt`.
- **No new runtime dependencies** without discussing it first.
- **Comments explain why, not what.** A comment restating the line above it is
  noise; one explaining why the obvious approach was wrong is the reason the
  next person does not undo your work.

## Reporting bugs

Include the TrueNAS version, whether it is bare metal or virtualised, and how
you installed EzNAS. A surprising amount turns on that: drives in a VM report
0°C, and apps deployed through TrueNAS's "Custom App" button carry no catalog
metadata at all — both have looked like bugs in this console before.

Security issues go through the Security tab instead. See `SECURITY.md`.
