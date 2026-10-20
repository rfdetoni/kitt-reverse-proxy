# KITT Reverse Proxy 5.4.14 — bounded recovery of tools context

- Requests to `request_tools` from a model that has already been given host tool definitions receive **one** in-session reminder referencing exactly the permitted tool names. The next response must be a validated tool action or a final response. No tool action is executed as part of the reminder itself.
- An empty declared host catalog remains empty: return a bounded recoverable context error, never an invented tool or approval.
- Repeated `request_tools` after the reminder fails without additional attempts.
- All tool validation, approval authority, operation policy and browser capture rules stay unchanged. CI tests exercise the HTTP request route.
