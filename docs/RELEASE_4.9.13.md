# Reverse Proxy 4.9.13

The reported Gemini turn failed with `agent_contract_invalid`. Its initial response contained a complete `use_tool` object, prefixed by a standalone JSON label, followed by the exact same object in a code fence. The parser rejected the duplicated presentation and requested two repairs. The final repair changed `reasoning_summary` and loop data; continuity correctly rejected that drift. No host tool was delivered.

Recovery now recognizes only a plain object and its exact fenced mirror, with an optional standalone JSON label. It parses one unchanged object and applies the existing duplicate-key, schema, ambiguity, depth and work limits. It never merges distinct decisions or deduplicates separate tool envelopes. The size limit covers the entire incoming text before removing wrappers or mirrors. Label-before-fence presentation is handled consistently.

The UI executor also prevents display-only artifact blocks from being appended to Agent and structured-output payloads. A separate regression reproduced a valid contract becoming invalid after an unrelated TypeScript artifact was appended. Generic chat artifact display and explicit filename-matched write hydration remain available. The logs establish the duplicated payload, but do not identify whether the duplication originated in the provider rendering or artifact augmentation.

Three new regressions failed before correction. Local verification passed 192 tests, TypeScript checks and production build; the router replay of the exact contract-only fixture returns one `kitt_runtime` call with `operation=repo.list` and `path=.` on the first upstream attempt, preserving the original summary. The Chromium CI fixture additionally exercises actual DOM snapshots and artifact extraction beside that captured presentation. Existing reader trust, cancellation, source preservation and error-delivery checks remain mandatory.

In the supplied logs the CDP tap stayed in shadow mode, lacked trust and fell back with `no_matching_request` or `stall`. This release repairs the concrete payload in the DOM fallback; it does not claim to repair Gemini's live request correlation or timing without request/response capture evidence. Authenticated provider sessions are not exercised by the fixture. Continuity restrictions remain enforced, and missing contract semantics are never invented.

Package and npm lock versions are 4.9.13. No Agent/Protocol wire or consumer dependency change is needed.
