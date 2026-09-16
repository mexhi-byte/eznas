# Architecture

One picture, then the three rules that keep it true.

```
  browser ──HTTP + WebSocket──▶ EzNAS console (Node) ──JSON-RPC over wss──▶ TrueNAS /api/current
     │                              │                                            │
     │  session cookie              │  API key (encrypted at rest)               │  reporting.realtime push
     │  role: admin | viewer        │  optional account password (sudo)          │
     │                              └──/websocket/shell (token per session)──────┘
```

- **The browser never holds a NAS credential.** It holds a signed session
  cookie naming a console account. The console holds the API key, encrypted
  with a key derived from `SESSION_SECRET` or a generated secret kept beside
  the data file, and speaks to the NAS on the browser's behalf.
- **The NAS is spoken to over JSON-RPC at `/api/current`**, the interface
  TrueNAS's own UI uses and the only one that survives 25.10. One socket per
  NAS is shared by every browser session. Long operations are jobs; the
  browser polls them.
- **What the API cannot do runs as a command over the shell WebSocket** —
  move, rename, delete, an app's logs — quoted and confined, built on the
  server from validated parts. The browser never sends a command.

## Layout

```
server/index.ts      start, secure, authenticate, choose the NAS, dispatch
server/routes/*.ts   one module per subject; each takes the same context
server/truenas.ts    the JSON-RPC client
server/nas-shapes.ts the rows the NAS returns, as far as we read them
web/*.tsx            one file per page, named for it
mock/                a TrueNAS that is not there, for tests and the demo
e2e/                 the browser test
```

A route module never imports `server/index.ts`, which starts the server at
import time. Shared helpers live in `server/http.ts`; the context type in
`server/routes/context.ts` is the whole contract.

## Authorisation, in one place

Every request passes, in order: same-origin and content-type checks on
writes; the session; the role gate (a viewer may `GET` and nothing else); the
first-run gate (an account still holding a generated password may only change
it). Then the console's own routes, then the NAS routes. Destructive routes
additionally require the name of the thing typed back, enforced on the server.
