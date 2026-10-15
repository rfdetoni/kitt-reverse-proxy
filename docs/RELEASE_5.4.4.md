# Reverse Proxy 5.4.4 — local result wrapping and provider message provenance

A complete strict JSON result with none of the Agent envelope fields is mechanically wrapped in `final_response.content`. Its parsed data is preserved exactly; no model repair/copy turn is needed, and it cannot become a tool call or loop. Partial envelopes, duplicate keys, ambiguous objects and invalid JSON still fail validation.

CDP capture excludes provider-native tool recipients and all known non-final assistant channels, including incremental channel/recipient patches. Late classification invalidates prior text from that message; subsequent assistant messages retain separate source state. Unclassified bare JSON is eligible only after final-channel classification or actual stream completion. This prevents native tool arguments from being mistaken for a plan or validation report.

Validated with unit regressions and real Chromium over a local provider fixture, including native tool output before the actual final answer. A live authenticated provider session was not used.
