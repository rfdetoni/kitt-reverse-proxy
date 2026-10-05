# Reverse Proxy 4.9.8 — lossless contract recovery and raw browser responses

Malformed transport JSON must never silently change an action or a file. This release fixes four reproduced failures: quote repair swallowing neighboring arguments; unrelated artifacts filling writes; a serialization retry becoming a false final success; and valid `$ref` compositions being rejected by the partial schema validator.

## Recovery pipeline

1. Read the submitted browser turn with the existing CDP network tap and DOM fallback.
2. Prefer the original response for buffered Agent/JSON/tool contracts only when the stream completed, matched the full submitted prompt, used an already trusted endpoint/extraction profile and had no tap failure. Different valid payloads in network and DOM fail recoverably; equivalent presentation wrappers can establish/retain profile trust.
3. Parse exactly one complete payload using the shared bounded grammar. Agent v2, tool envelopes and structured output reuse syntax recovery; their semantic validators remain separate.
4. Validate the canonical Agent shape, caller tool allowlist and JSON Schema. Structured `json_schema` supports non-object roots; `json_object` still requires an object.
5. If local recovery cannot resolve corruption, request a same-session repair with the error category, affected JSON paths and original candidate. Preserve every unambiguous, unaffected candidate member. Repairs cannot replace a known pending tool action with a final response, change a valid sibling argument, or use a drifting retry as the next source of truth.
6. Stop on an unchanged candidate or exhausted work/attempt/deadline budget and return the existing recoverable error/continue surface.

Local recovery handles raw control characters, literal non-JSON source escapes (`\\x00`, `\\d`), unambiguous unescaped quotes, single/smart quote delimiters, bare keys, complete comments, trailing commas and missing separators between complete grammar tokens. It preserves indentation, CR/LF, tabs, Unicode and final newlines inside content. Already valid strings are immutable. Duplicate keys, multiple payloads, ambiguous quote interpretations, truncated data and fabricated scalar values are rejected. A parseable/schema-valid guess is not proof of lossless restoration.

Limits: 2 MiB input, 64 nesting levels, 2,048 members per container, 256 ambiguous branches/states and 4,000,000 scanner work units. Syntax errors include a source offset. Limits are checked before upstream repair; no combinatorial quote-variant queue remains.

## Schema and artifact integrity

Ajv replaces the partial validator and preserves root references across `anyOf`/`oneOf`; `not` and other supported draft-07/2019-09/2020-12 constraints are enforced. Invalid/unsupported schemas are rejected before provider allocation/submission. Validation never coerces types, inserts defaults or removes properties. Formats are validated with the standard Ajv format plugin. External schema resolution and asynchronous schemas are unsupported. Compilation has bounded schema size/complexity and a 256-entry cache whose evicted Ajv schema objects are also released.

Artifact hydration requires an explicit matching filename/path from the current response. Empty content remains empty. Oversized artifacts are rejected rather than sliced; virtualized editor text is not treated as a complete file. UTF-8 data artifacts and whitespace are preserved. A single unrelated artifact no longer fills a write.

The CDP tap also waits for buffered response bytes before publishing completion when `loadingFinished` races with `streamResourceContent`. Response extraction never parses HTML to reconstruct network payloads. DOM mode remains available; raw recovery is conditional and does not guarantee that a provider/model always emits valid contracts.

Tool envelope extraction preserves every separate call instead of selecting the last closing tag and losing earlier calls. Literal tool markup inside JSON source strings remains data, and the existing parallel-call limits still apply. Invalid UTF-8 is rejected instead of silently inserting replacement characters. Repair anchors include complete nested arguments observed before a truncated field; a faithful repair may expose additional schema violations without permitting unrelated data changes.

Tap profiles learn an explicit delta or cumulative-snapshot mode by comparison with completed DOM responses. Repeated delta tokens are appended verbatim; they are not heuristically deduplicated. Snapshot replacements that do not extend the previous prefix invalidate raw selection. Profiles without a verified extraction mode cannot supply raw contract text.

## Compatibility and validation

No HTTP headers, Agent v2 fields, ContextEnvelope schema, tool-result wire shape or recoverable error contract changes. Agent CLI 0.83.15 and Protocol 0.9.0 remain compatible. Memory, Toolbox, Assistant and AI Workers need no code or dependency bump for this transport fix. The root release snapshot must promote the new Proxy revision.

Validation covers the complete Proxy suite, typecheck/build, fast installer build, package contents, installer syntax and dependency audits; focused Agent CLI compatibility/budget/tool-payload tests; Protocol fixtures/typecheck; generated ContextEnvelope parity; and root installer tests. Regression cases include false-final drift, stalled/budget-limited repairs, exact file content, optional sibling preservation, artifact mismatch, ambiguous/multiple/truncated JSON and CDP completion correlation/races. Authenticated live web-provider sessions are not exercised by these local checks.
