# KITT Reverse Proxy 5.4.12

## Compact tool actions within Agent contract v5

- WebChat agent tool requests may use a single exact `<tool_call>{"name":"kitt_runtime","arguments":{...}}</tool_call>` envelope, reusing the existing tool envelope decoder. JSON Agent contract v5 remains accepted and remains the required format for final responses.
- Native provider `tool_calls` are validated as structured calls if an upstream adapter produces them; no additional model call is needed solely to reserialize them into the six-field JSON action.
- Tool availability, argument size, schema checks, authorization and approvals remain enforced by the existing proxy/host boundary.
- Host execution remains **one action per agent turn**. Independent reads may be grouped using the already-supported `repo.batch_read`. Free-form prose and quoted tool examples never trigger execution.
- Existing WebChat DOM/raw capture reconciliation stays unchanged. This release does not claim improved authenticated WebChat capture reliability or measured token/latency savings.

## Validation

`npm run verify` and GitHub CI must pass before merging. Native network forwarding is still controlled by the existing profile-capability handling: this change does **not** advertise native tools to a provider that cannot accept them.
