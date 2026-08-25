## What this changes

<!-- What behaviour is different afterwards. -->

## Why

<!-- What was wrong before. Assume the reader can see the diff and cannot see
     your reasoning. -->

## Checks

- [ ] `npm test`
- [ ] `npx tsc -p tsconfig.json --noEmit`
- [ ] `npx tsc -p tsconfig.server.json --noEmit`
- [ ] `npm run build`

## Verified how

<!-- Tests are necessary and not sufficient — 0.5.0 passed its whole suite with
     three features unreachable from the browser. Say what you actually did:
     which pages you opened, against what TrueNAS version, and what you saw.
     "Not tested against hardware" is a fine answer; a silent one is not. -->

- [ ] I broke what I was testing and watched the test fail before making it pass
