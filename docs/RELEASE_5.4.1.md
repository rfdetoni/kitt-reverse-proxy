# Reverse Proxy 5.4.1 — capture complete JSON before schema validation

DOM and correlated assistant CDP capture now deliver complete, unambiguous JSON objects to the host even when the Agent envelope is missing. A missing envelope becomes a bounded contract repair instead of a browser capture timeout. Full schema validation and current-turn tool authorization remain mandatory before execution.

Repair of a bare structured result is restricted to wrapping the exact original object in `final_response.content`, with null tool, tool_input and loop. Altered data and invented tool calls are rejected. Partial Agent envelopes retain their existing stable-field continuity checks. Completion also observes the quiet period after CDP end, preserving login/intervention, cancellation and delivery-error precedence.

The supplied incident logs show a matched stream receiving bytes with no extracted answer. They do not include the response text, so a bare result in that specific incident remains unconfirmed. New bounded tap failure diagnostics record framing, event counts and candidate metadata; candidate text and raw stream excerpts require explicit full-content logging.

Validation: 267 unit tests and 12 real Chromium integrations, including network-only bare planning JSON, exact-content repair and rejected tool synthesis. No authenticated live ChatGPT session was available.
