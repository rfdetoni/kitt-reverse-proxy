# KAP/2 WebChat capture limitations (5.3.7)

The reverse proxy is a transport adapter, not the source of KAP grammar or
tool authorization. It observes model responses through provider-owned DOM.
Model messages sometimes appear collapsed to a single line. A unique, newly
visible `K2 F ... K2/END` frame can be forwarded for host validation and
repair; the proxy does not guess nesting or line breaks.

## Current bounded behavior

- Contract frames: at most 64 KiB in the strict parser.
- DOM snapshots are bounded; long prompts/transcripts can be virtualized or
  truncated by the website independently of KAP grammar.
- Read mode `auto` uses DOM for ChatGPT/Gemini; network tap is not assumed
  authoritative.
- Echoes of submitted prompts, previous frames, multiple competing replies,
  unterminated replies or oversized candidates cannot be promoted.
- If a model output loses field boundaries, the only safe recovery is a fresh,
  properly delimited response. A one-line envelope is not magically parseable.
- Provider UI version, rendering and background generation remain external.
  Production end-to-end validation requires an authenticated WebChat session.

The timeout/delivery budget and size caps are independent from AST / schema
limits in `kitt-protocol`; raising timeouts is not a substitute for capture
fidelity.
