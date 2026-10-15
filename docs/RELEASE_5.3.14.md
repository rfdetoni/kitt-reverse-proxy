# Reverse Proxy 5.3.14 — protocol conformance CI

- Run authoritative Protocol KAP/2 fixture corpus against the compiled shipping proxy parser in CI.
- Assert exact decoded structured finals and expected error codes for malformed inputs.
- Keep parser byte-identical to the Protocol TypeScript SDK and retain existing DOM freshness/transport validation tests.
- No parser grammar, provider automation, security boundary or runtime dependency changes.
