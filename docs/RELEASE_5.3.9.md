# Reverse Proxy 5.3.9 — KAP/2 compact final contract parity

Reproduction: operator ChatGPT Web v5.3.8 log from 2026-10-14,
request f49b320fbb1b4fa29dc1e60bdd7fa403.
- 13,476-character assistant reply was successfully captured.
- `agent.contract.validation.detail` reported `Invalid K2 header` even
  though the new canonical KAP/2 syntax is `K2 F @json: {...}\nK2/END`.
- The proxy retried unnecessarily and discarded the earlier frame as stale;
  the agent saw 0 chunks and `ui_timeout`.

The internal KAP/2 parser is synchronized with the compact-final feature
published in Protocol 0.13.3. It rejects duplicate keys, unsafe keys,
non-finite values, malformed escapes and oversized/deep containers.
Semantic final-plan rules are still checked by the Agent CLI, so plans
missing the required FINAL item must still be rejected/reprompted by the host.

No other endpoints, model prompts or policies change. CI cannot replace
an authenticated WebChat regression test. The reverse proxy still embeds
a KAP/2 parser, which is technical debt; follow-up migration to the shared
SDK should be evaluated separately instead of weakening the validators.
