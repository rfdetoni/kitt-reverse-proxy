# Reverse Proxy 4.9.6 — bounded full-content logging

## Scope

Fix a crash observed immediately after Agent contract correlation when the proxy runs with:

`--log-level 2 --log-content full`

The next trace logs execution options that include runtime lifecycle objects. Full-content logging previously disabled the existing structured-log depth guard, so cyclic runtime references could recurse until Node raised:

`RangeError: Maximum call stack size exceeded`

## Changes

- Apply `RESOURCE_LIMITS.structuredLogDepth` in full-content mode as well as metadata/none modes.
- Keep full-content visibility for strings and payload fields within the configured structural depth.
- Preserve existing array/object expansion semantics for full mode.
- Add a regression test with a cyclic runtime object and verify full payload text remains visible while recursion terminates at `[MAX_DEPTH]`.

## Validation

Run `npm run verify`. Release CI additionally validates the production build and Docker/browser targets.

No Agent, Protocol, session, or provider contract change is required.
