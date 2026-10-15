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
- Read mode `auto` arms DOM and passive CDP readers for ChatGPT/Gemini.
  Network output requires current-request correlation and strict, unique KAP/2
  validation; arbitrary network events are not authoritative.
- Echoes of submitted prompts, previous frames, multiple competing replies,
  unterminated replies or oversized candidates cannot be promoted.
- If a model output loses field boundaries, the only safe recovery is a fresh,
  properly delimited response. A one-line envelope is not magically parseable.
- Provider UI version, rendering and background generation remain external.
  Production end-to-end validation requires an authenticated WebChat session.

The timeout/delivery budget and size caps are independent from AST / schema
limits in `kitt-protocol`; raising timeouts is not a substitute for capture
fidelity.

## 5.3.15: operational KAP/2 actions

The previous DOM mutation observer only stored newly rendered text containing
`K2 F` and `K2/END`. A tool action (`K2 T`) could be missed when ChatGPT Web
did not expose recognizable assistant-role or conversation-turn selectors.
The observer now records bounded candidate envelopes starting with any
`K2 T/F/W/Q`. The existing strict parser and pre-submit baseline/prompt echo
exclusion still decide whether the response belongs to the current turn.
This does not change KAP/2 syntax or authorize anything from page text.

Regression coverage exercises fresh `K2 T` with absent role nodes, a long prompt
containing a tool example, and duplicate/prior-frame rejection.
An authenticated browser E2E remains required to confirm the provider DOM.

## 5.3.16: response origin before content equality

A new submitted-prompt boundary in the visible transcript can establish that a
strict KAP reply is new even when its bytes repeat an example or prior action.
The occurrence count must increase by exactly one relative to the pre-submit
baseline; changing sidebar chrome alone is insufficient. Roleless samples
without this evidence still use the existing prompt/baseline exclusions.

Mutation capture retains both innerText (rendered line boundaries) and
textContent (source indentation). A unique fresh flattened frame with UI chrome
can reach host repair, while duplicate malformed and competing frames stay
blocked. This is capture recovery, not an automatic provider replay.

## 5.3.17: independent readers in auto mode

Auto mode no longer disables CDP for ChatGPT/Gemini. A DOM-only failure must
not discard a complete current-request KAP/2 frame from the passive reader.
Text patches are assembled per declared answer target and operation, including
continuation events. Patches do not teach a generic `$.v` profile. Explicit user,
system, developer and tool message branches, metadata and competing frames are
excluded. `--read-mode dom` still explicitly disables CDP. No request is replayed.
