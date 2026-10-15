# Reverse Proxy 5.4.0 — JSON model wire format

Agent contract v5 accepts one JSON response object, validates the shared response schema and current host tool schema, then maps it to OpenAI-compatible results/tool calls. KAP grammar copies, negotiation, operation aliases, markers and grammar-specific repair paths are removed from the application.

DOM and passive CDP still observe the same submitted turn independently. Text capture is independent of grammar markers; bounded JSON object selection excludes prompt examples, pre-submit answers and competing responses. Only complete schema-valid JSON from correlated assistant fields can win the tap race. Capture failures never replay a submitted prompt.

Serialization repair preserves stable JSON members, action and tool. Duplicate keys, competing objects, unapproved tools, oversized arguments and unrelated field changes fail closed. Tool argument bytes and source strings remain host-validated.

This removes model serialization complexity; a provider stream abort or a browser UI failure can still require session inspection. No live authenticated provider session was used for validation.
