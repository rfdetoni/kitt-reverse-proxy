# K.I.T.T. Reverse Proxy 5.4.17

The existing ChatGPT response capture path now reports completed-but-uncorrelated submissions as HTTP 409 `ui_capture_unverified` with explicit `continue` as the only safe recovery, instead of a generic timeout. Never auto-replay a possibly submitted browser turn. Diagnostic telemetry includes CDP correlation failure, tap receiving state and time since generation stopped; no request content or account data is logged by the new fields. Validate TypeScript CI, Docker and the Agent/Proxy v5 integration contract.
