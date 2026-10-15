# Reverse Proxy 5.4.3 — ordered assistant patches and protocol EOF

The supplied 5.4.2 logs show successful planning and `repo.list`, followed by a capture timeout on the next assistant turn. Its bounded stream excerpt contains patch batches shaped as `v: [{p, o, v}, ...]`, a `</escape>` presentation suffix, a complete action copied in renderer metadata, and SSE `[DONE]` before CDP reported `stream_aborted`.

Contract capture now processes both explicit and implicit patch batches, seeds nonempty message snapshots before applying deltas, and keeps message identities separate. Complete outer `<escape>...</escape>` presentation is removed without rewriting JSON strings. Analysis/commentary/thought data, user echoes and metadata copies cannot supply an action. Multiple distinct assistant objects remain ambiguous.

After a connection failure, only a correlated, complete, unambiguous assistant JSON object plus an observed SSE `[DONE]` can survive. Incomplete text, missing EOF, metadata-only data, byte/decode limits, cancellation and manual intervention still fail closed. Capture remains bounded and does not replay prompts. Host Agent v5 schema/tool authorization remains mandatory.

Validation: 270 unit tests and 15 real Chromium integrations. The fixture preserves the 3,400-character action recorded in the diagnostic as data; its embedded command is never executed by the tests. Reproduction covers the observed framing and post-EOF connection failure; the original full stream and an authenticated live provider session were not available.
