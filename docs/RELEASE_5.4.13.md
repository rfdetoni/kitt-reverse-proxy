# Reverse Proxy 5.4.13 — sequential native function calling

- Agent CLI sends `parallel_tool_calls=false` on every structured KITT tool request. A network transport with `openai.tools_json` and compatible `tool_choice` bindings now forwards native calls even with that host restriction.
- Network response normalization still rejects more than one tool call, and the Agent v5 contract independently enforces one tool action per turn.
- Textual browser transports keep the explicit compact `<tool_call>` path; no inference from ordinary prose.
- Regression: HTTP Agent v5 with `parallel_tool_calls=false` and an available native tool must forward the native tool definition and preserve the `call_id`.
- The authenticated UI and timing gains remain unmeasured.
