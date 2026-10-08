# kitt-reverse-proxy 5.0.1 — Reject ambiguous decisions throughout recovery

The parser rejected competing interpretations, but the HTTP orchestration path still submitted them for model-side serialization repair. A model could then choose one interpretation and produce an accepted response. Reproduction returned HTTP 200 both for conflicting OK/REJECT review verdicts and ambiguous write-file arguments.

Ambiguity is now terminal for the current request, with HTTP 409 / agent_contract_invalid and no additional repair submission. The same guard applies when a syntax repair introduces duplicate keys or competing interpretations. No content or tool call is returned from that request. The caller can begin a fresh decision turn through the existing continue recovery action.

Unique schema-based local recovery remains available, including the logged unescaped nested JSON case. Faithful repairs of incomplete syntax and reported schema violations retain their existing bounded attempts and continuity checks. Agent contract v3 and Protocol 0.10.0 are unchanged; Agent 0.85.0 and existing consumers remain compatible. WebChat owns token limits.

HTTP regressions prove that a valid proposed repair cannot override conflicting verdicts or tool arguments, and that ambiguity introduced by the first repair prevents a third submission. Existing structured-result, raw-quote, tool continuity and schema repair checks remain enabled. No fresh authenticated Gemini session was executed.
