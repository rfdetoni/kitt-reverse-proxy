# Reverse Proxy 5.3.12 — per-turn processing efficiency

- De-duplicate overlapping DOM snapshots before KAP/2 candidate parsing and repair checks.
- Replace per-event front-array shifts in the CDP tap queue with a cursor and bounded periodic compaction.
- Preserve turn order, buffered delivery through close(), freshness checks, source trust and cancellation.
- Synchronize package.json and package-lock.json versions at 5.3.12.

No KAP/2 grammar or host policy changes.