# Changelog — K.I.T.T. Reverse Proxy

## 5.4.26 — bounded Playwright browser diagnostics and patched dependencies

- Override vulnerable transitive body-parser to 2.4.0 and fast-uri to 3.1.9 with the published package integrity hashes; retain audit and npm ci checks.
- Capture real page console errors/warnings, JS exceptions, failed requests and HTTP 4xx/5xx in each automation session. Store only event type, allowlisted origin, resource category and SHA-256 message fingerprint; never return raw headers, request bodies or secrets from console text.
- Add read-only `diagnose` browser action with event counters and bounded recent evidence. Preserve origin enforcement and session isolation. Synchronize package-lock.json with package.json.


## 5.4.25 — wait for slow HTTP response to an already-correlated CDP POST

Stop falsely reporting no_matching_request after 4 seconds when all prompt anchors have already matched a high-scoring, provider-scoped POST but its HTTP response has not arrived. Wait once for a bounded response window (the configured first-byte timeout, max 90s), then fail closed if still absent; associate only by identical requestId and retain cross-turn isolation. Emit redacted eligible-candidate diagnostics and regression tests for delayed response and no-response cases. Existing dependency pins unchanged; package-lock synchronized.

## 5.4.24 — reuse authenticated startup tab for first named agent

First named agent session adopts the already authenticated bootstrap tab, preventing a second idle tab. Additional independent agent sessions receive separate pages; default-route use before adoption leaves the default tab untouched. If default is used after adoption, its separate tab is created lazily, preserving session and CDP correlation isolation. On agent eviction the adopted page is closed; shutdown alone owns the native Chrome process/profile. Focused lifecycle tests, package lock versions synchronized, no dependency pin changes.


## 5.4.23 — correlate segmented typed WebChat prompt content without guessing

The CDP passive reader now joins adjacent typed text parts only inside one content array; it never joins separate messages, roles, non-text parts or metadata. Redacted aggregate correlation diagnostics include highest observed anchor count and candidate score, making `no_matching_request` actionable without copying prompts. Explicit-continue-only capture failures and exactly-once UI submission are preserved. Focused positive/negative tests guard cross-turn misattribution. Dependencies and pins unchanged; package-lock version synchronized.


## 5.4.22 — reject empty WebChat agent actions without unsafe replay

A Gemini Web response of `{}` does not contain an action, a result, or enough evidence to serialize a faithful KITT host instruction. The agent gateway now returns a typed recoverable `agent_contract_empty_action` error immediately rather than submitting a speculative repair that can occupy the browser session for minutes. No host tool is invoked and no invented action is accepted. A regression verifies one upstream attempt and the explicit failure, while valid actions retain the existing bounded recovery behavior. Dependency pins and package lock remain consistent with the release.

## 5.4.21 — bounded child session under high Chromium startup memory

The 2026-10-21 Wine-MBS logs show the primary agent executing in a named ChatGPT Web session while a diagnostic child received `session_limit_exceeded`: Chromium startup RSS was already over the configured budget (768 MiB), and both the default session and the busy primary could not be recycled. The existing baseline exception only admitted one named session.

When the **captured startup baseline itself** exceeds the configured RSS cap, admit at most two named sessions total (one agent and one child) under the original fixed 512 MiB baseline headroom. The usual max-session and max-browser-pages limits still apply; later RSS growth past headroom and additional concurrent children are rejected. This exception never adjusts the baseline dynamically, does not recycle busy conversations and leaves the background idle grace unchanged. Tests cover active parent+child, third denial and headroom overflow. Runtime users with larger deliberate concurrency still need sufficient browser memory or a higher configured budget.

## 5.4.20 — retain on-demand LRU for isolated planning sessions

Keep the bounded five-minute **background** resource-pressure eviction grace introduced in 5.4.19, protecting the current agent session between host-tool and model calls. Unlike background sweeps, on-demand admission must still recycle a finished idle named session immediately: the Agent CLI creates distinct isolated session IDs for consecutive planning turns before the executor session. Reusing the original count-and-resource LRU admission behavior prevents premature `session_limit_exceeded` during those planning turns. Add a regression reproducing two isolated plan sessions, one executor session and a pressure sweep before tool-result continuation. The startup baseline bound, busy-session protection and resource quotas remain enforced. Synchronize package and lock at 5.4.20.

## 5.4.19 — preserve active agent sessions under Chromium memory pressure

Protect recently used named sessions for up to five minutes of idle time when recycling under browser RSS/page pressure, without extending their normal configured idle expiration. This preserves a session ID across host tool execution and prevents the next model call from failing after immediate pressure eviction. Creating a *different* session remains subject to memory and page limits; the proxy rechecks resource pressure after evicting a stale browser session instead of assuming RSS is immediately released. The existing bounded startup baseline allowance remains intact. Regression coverage proves same-session continuation, new-session refusal and safe stale-session recycling. Synchronizes package.json and package-lock.json at 5.4.19.

## 5.4.18 — bounded Chromium baseline memory-pressure admission

A headed Chromium instance may exceed the configured RSS limit before a named session starts. The existing one-session admission exception now uses the startup memory baseline plus at most 512 MiB of additional growth (or the configured limit, whichever is higher), instead of allowing unbounded memory increase. The guard prevents creating another session under excessive pressure; it does not claim to eliminate Chromium's memory footprint or diagnose a leak. Admission logs expose the captured baseline and headroom. Regression coverage and `package-lock.json` are synchronized with 5.4.18.

## 5.4.17 — typed manual continuation for unattributed completed WebChat replies

When the ChatGPT UI finishes generating but neither CDP nor DOM provenance can associate a response with the current submitted turn, return a typed `UiUncorrelatedCaptureError` (409 `ui_capture_unverified`, explicit continue) rather than a generic 504 timeout. No old DOM candidate is trusted and the prompt is never automatically replayed. Bounded capture diagnostics now include tap correlation state, time since generation stopped, and the required recovery mode without exposing prompt bytes. Existing request idempotence and model/provider boundaries remain unchanged. [Notes](docs/RELEASE_5.4.17.md).


## 5.4.16 — prevent silent Agent provider substitution

Agent Contract v5 requests now verify that the requested model ID matches the instance's actual model before any browser submission. Misbound Gemini/ChatGPT roles return a clear `agent_model_mismatch` 409 rather than silently executing with a different provider. Regular non-Agent OpenAI-compatible calls are unchanged. Adds a real HTTP regression covering the no-submission guarantee. [Notes](docs/RELEASE_5.4.16.md).


## 5.4.15 — single session invalidation on transport failure

A single failed named or default WebChat request now increments the session generation exactly once, rather than once in `lease.execute` and again in the enclosing transaction. This keeps context-key rotation and session diagnostic counters stable without changing browser isolation, request idempotency, contract v5 or retry authority. A focused regression checks the generation boundary. [Notes](docs/RELEASE_5.4.15.md).


## 5.4.14 — bounded request_tools recovery

If the model asks for a tool catalog that the host already supplied, retry once with a terse catalog reminder instead of ending the turn. Never synthesize privileges for a request without host tools; repeated requests fail closed. [Notes](docs/RELEASE_5.4.14.md).


## 5.4.13 — native tool calls with sequential host execution

The Agent CLI requires `parallel_tool_calls=false`. Honor it as a host-output limit rather than falling back to WebChat emulation for native-capable network profiles. Keep single-action validation and explicit host approval. Add a network-style HTTP integration regression. [Release notes](docs/RELEASE_5.4.13.md).


## 5.4.12 — compact explicit tool actions and validated native calls

Agent contract v5 accepts a single explicit `<tool_call>` envelope from WebChat or a native provider `tool_calls` completion without model-side JSON re-serialization. Both use the existing tool allowlist, argument schema and host approvals. Prose extraction and multi-action batches remain intentionally disabled. Adds focused regressions for malformed and unauthorized calls. [Release notes](docs/RELEASE_5.4.12.md).

## 5.4.11 — reject empty completions, constrain repair, split validation

Reject blank and empty-object final agent responses instead of accepting false task completion. Restrict JSON contract repair from replacing an entire host tool input on coarse schema errors. Extract stateless Agent contract validation from session orchestration, keeping the current external interfaces. Bump package lock and add a focused regression case. [Notas](docs/RELEASE_5.4.11.md).


## 5.4.10 — ChatGPT composer integrity for short tool continuations

Fixes 1695→1696-character rich-editor mutation after a KITT tool result: a bounded verified DOM replacement now covers all prompt sizes and never replays the corrupted draft via keyboard. Adds adversarial tests and bumps npm lock. [Notas](docs/RELEASE_5.4.10.md).

## 5.4.9 — DeepSeek 1.2.1 e controles de continuidade

Proteção contra respostas paradas do DeepSeek: recuperação do botão «Continuar» somente no cartão da resposta atual, sem reenviar prompts nem confirmar controles de autenticação ou consentimento. Validação de contrato e reparação JSON limitadas. [Notas completas](docs/RELEASE_5.4.9.md). O CI não comprova interação com sessão WebChat autenticada.


## Histórico migrado do README

## Reverse Proxy 5.4.5 — current-turn DOM contract selection

When ChatGPT Web renders a long conversation with several historical JSON objects, a proven newly-submitted prompt boundary now scopes response capture to its own trailing region instead of mixing unrelated page frames. Long prompts tolerate a reformatted prefix while still requiring a unique sufficiently long trailing anchor and an exact pre-submit baseline delta. Ambiguous, historical and echoed JSON actions remain rejected; CDP tap authorization is unchanged. This mitigates `ui.response.capture_missing` / `ui_timeout` cases without replaying a request or executing untrusted content.

[Release details](docs/RELEASE_5.4.5.md).

## Reverse Proxy 5.4.4 — local result wrapping and provider message provenance

A complete strict JSON result with none of the Agent envelope fields is mechanically wrapped in `final_response.content`. Its parsed data is preserved exactly; no model repair/copy turn is needed, and it cannot become a tool call or loop. Partial envelopes, duplicate keys, ambiguous objects and invalid JSON still fail validation.

[Release details](docs/RELEASE_5.4.4.md).

## Reverse Proxy 5.4.3 — ordered assistant patches and protocol EOF

Captures implicit patch batches and complete escape-wrapped assistant JSON while excluding thoughts, user echoes and renderer metadata. A complete correlated response with SSE `[DONE]` survives a subsequent connection failure; partial or ambiguous data remains rejected. [Release details](docs/RELEASE_5.4.3.md).

## Reverse Proxy 5.4.2 — exclude prompt examples and wait for generation

Rendered JSON examples remain excluded when the browser changes token whitespace. DOM capture waits for generation to stop, and the next request collects its baseline and edits the composer only after the preceding reply is complete. Cancellation and busy timeout preserve the draft. [Release details](docs/RELEASE_5.4.2.md).

## Reverse Proxy 5.4.1 — complete JSON capture and faithful repair

Complete JSON results now reach host validation even when the model omits the Agent envelope. Bounded repair can wrap the exact result in `final_response.content`; it cannot change the result or create a tool call. Capture keeps prompt/history exclusion, ambiguity rejection, cancellation and intervention checks. [Release details](docs/RELEASE_5.4.1.md).

## Reverse Proxy 5.4.0 — JSON model wire format

Agent contract v5 accepts one JSON response object, validates the shared response schema and current host tool schema, then maps it to OpenAI-compatible results/tool calls. KAP grammar copies, negotiation, operation aliases, markers and grammar-specific repair paths are removed from the application.

[Release details](docs/RELEASE_5.4.0.md).

## Reverse Proxy 5.3.13 — reusable DOM mutation observer

UI response monitoring now reuses one mutation observer per active page instead of repeatedly allocating/disconnecting it on each polling iteration. The observer is disconnected after two idle seconds, and the existing watchdog, freshness, DOM trust, complete-frame and cancellation contracts are preserved. [Release notes](docs/RELEASE_5.3.13.md).

## Reverse Proxy 5.3.5 — DOM final response recovery

The authenticated ChatGPT Web incident on 5.3.4 showed a complete browser response but `response_chars=0`, with two visible DOM text samples and a terminal marker. This release broadens the DOM reader to include portal-rendered body replies; records consistent pre-submit snapshots before both initial and repair requests; returns only fresh, stable, structurally delimited but malformed model text to the existing host contract repair flow (not as a valid response); and adds counts-only diagnostics. CDP stays disabled for ChatGPT/Gemini auto mode. See [release 5.3.5](docs/RELEASE_5.3.5.md).

## Reverse Proxy 5.3.1 — bounded ChatGPT capture recovery

Long submitted prompts with split request content now correlate without weakening strict anchors. A completed answer in the newest assistant-style conversation turn can be validated even if role attributes changed. See [5.3.1 release notes](docs/RELEASE_5.3.1.md). Live-site reproduction remains a required operator acceptance gate.

## Release 5.1.4 — Native textarea handling for large WebChat prompts

Confirm the editor is actually editable, then use one native input event for large textarea prompts instead of Playwright's slow browser fill path. Validation still prevents sending corrupted drafts. See [release notes](docs/RELEASE_5.1.4.md).

## Release 5.1.3 — Reliable large WebChat prompts

Prevents the current Agent task from being replayed as browser history, verifies rich-editor content using rendered and raw text, and avoids slow keyboard reinsertions when large drafts fail validation. See [release notes](docs/RELEASE_5.1.3.md).

## Release 5.1.2 — Safe regeneration of interrupted FINAL envelopes

For a truncated Gemini `ACTION FINAL` followed by a new complete FINAL, the proxy discards both competing drafts and requests a fresh, independently validated response within the existing retry budget. Other ambiguities and tool actions still fail closed. Prompt instructions consistently name `KITT/1`. See [release notes](docs/RELEASE_5.1.2.md).

## Release 5.0.2 — Select an enabled chat send control

Submission searches all visible candidates for an enabled send control. A disabled native/ARIA variant no longer masks an active button or sends the flow to Enter, which may only insert a newline in Gemini. Logs distinguish button dispatch, Enter fallback and confirmed acceptance. See [release notes](docs/RELEASE_5.0.2.md).

## Release 5.0.1 — Ambiguous decisions never enter model repair

The HTTP recovery flow returns 409 immediately when the response has competing contract interpretations or duplicate keys, including when ambiguity first appears in a repair response. Syntax repair cannot ask a model to choose a verdict or tool arguments. Unique local recovery and faithful syntax/schema repairs remain available. See [release notes](docs/RELEASE_5.0.1.md).

## Release 5.0.0 — Agent contract v3

Structured plans and review/validation/completion reports travel as objects directly in content. Protocol 0.10.0 owns the response schema and identifiers; Agent 0.85.0 is the compatible consumer. Unsupported Agent versions fail explicitly instead of falling through to generic chat. Unique shape-based recovery remains available. See [release notes](docs/RELEASE_5.0.0.md).

## Release 4.9.19 — Nested JSON contract recovery

Agent-contract recovery uses its mandatory field shape to discard parses that swallow required fields when WebChat omits quote escapes inside content. Exactly one matching interpretation is required; competing tool arguments remain invalid. The complete content is preserved without another provider request.

See [release notes](docs/RELEASE_4.9.19.md).

## Release 4.9.18 — WebChat owns token limits

Prompt and completion token estimates are telemetry. Request lifecycle admission enforces attempt/deadline controls without a local token ceiling. Legacy max_prompt_tokens metadata is accepted for rolling upgrades and ignored.

See [release notes](docs/RELEASE_4.9.18.md).

## Release 4.9.17 — Session admission and browser cancellation

Session resolution reserves an admitted caller before asynchronous dispatch. Capacity recycling, idle sweeps and deletion respect reservations; all queue/error paths release them. Automation cancellation closes its dedicated tab and checks before further actions. Agent-contract tool arguments share the inclusive 64 KiB UTF-8 JSON limit with the generic tool route and Agent CLI.

See [release notes](docs/RELEASE_4.9.17.md).

## Release 4.9.16 — Agent-owned managed services

Managed services started through the Agent control plane now receive the Agent's log level/content and a dedicated log file in the same log directory. The control plane persists those settings across restart. Agent-started service processes also receive an owner PID and terminate when that Agent process disappears; manually started services do not receive ownership and are unaffected.

The shared Browser Host remains profile-owned rather than tied to one Agent PID, so one Agent exiting cannot tear down a browser host still used by another service. See [release notes](docs/RELEASE_4.9.16.md).

## Release 4.9.15 — Passive RPC capture and human ChatGPT login

The passive tap now correlates POST bodies omitted by CDP, arms its request deadline immediately before browser submission, and learns individual reply paths inside positional arrays and encoded JSON strings. Trusted completed captures preserve the original contract if browser rendering damages it. ChatGPT now uses the human Chrome login bootstrap before automation attaches, including managed services. No request is replayed and no private provider endpoint is fixed. See [evidence and limits](docs/RELEASE_4.9.15.md).

## Release 4.9.14 — Confirm browser submission before waiting

UI submission now requires a cleared readable composer, newly active generation control, or a changed assistant response. An ignored click/Enter or unreadable editor raises an actionable error after the existing five-second confirmation budget instead of silently starting the response watchdog. Active generation preserves the current draft. Submission and response monitoring use the same semantic streaming selectors, with metadata-only diagnostics. See [evidence and limits](docs/RELEASE_4.9.14.md).

## Release 4.9.13 — Gemini contract presentation recovery

A complete plain JSON object followed by its exact fenced copy is one renderer presentation and can be decoded locally. Differing copies, additional prose, multiple bare objects and duplicate keys remain rejected. Source fields are unchanged; the complete input stays within the 2 MiB recovery bound.

Agent and structured-output responses no longer receive appended display artifacts. Generic chat still receives artifact display blocks, and explicit tool artifact hydration retains its existing matching rules. A contract-only fixture from the reported Gemini failure now executes its original `repo.list` call in one upstream attempt. See [evidence and limits](docs/RELEASE_4.9.13.md).

## Release 4.9.12 — hybrid delivery failures and DOM lag

Propagate consumer delivery failures unchanged, observe tap-task rejection immediately and stop the concurrent DOM monitor when delivery fails. Decode failures keep their existing fallback; callback failures no longer masquerade as corrupted provider bytes. A lagging DOM may catch up to an already delivered prefix without replay, while final divergence and truncation remain errors.

The Chromium gate now runs the full hybrid reader: trust acquisition, raw contracts with damaged HTML and failed-consumer monitor cancellation. See [release notes and limits](docs/RELEASE_4.9.12.md).

## Release 4.9.11 — CDP lifecycle and source integrity

Serialize CDP attachment, reconnection and detachment; release partially attached sessions on failure. Preserve buffered-before-live byte order while streaming activates, including the existing turn byte budget. Reject redirects, changed final response URLs and non-success HTTP bodies before raw extraction. Both SSE decoding paths preserve indentation and multiline data across CR, LF and split CRLF boundaries.

CI now exercises real headless Chromium against a local SSE fixture, earns a profile from a matching DOM response and recovers later completed contracts with damaged HTML. This controlled browser test does not cover authenticated provider accounts. See [release notes and limits](docs/RELEASE_4.9.11.md).

## Release 4.9.10 — execution boundary hardening

Preserve completed raw CDP contracts when the DOM monitor times out. Refresh the transitive lock to proxy-addr 2.0.8 for [GHSA-jqcg-44mw-7w3h](https://github.com/advisories/GHSA-jqcg-44mw-7w3h); retain the dependency audit gates. Recovery requires full-prompt correlation, a previously trusted active profile, explicit stream end and strict valid JSON. Competing delta/snapshot payloads still fail. Cancellation, sign-in/manual intervention and other monitor errors remain errors. Authenticated live WebChat is not covered by local fixtures.

See [release notes](docs/RELEASE_4.9.10.md).

## Reverse Proxy 4.9.9 — stream mode ambiguity guard

Active CDP profiles retain an alternative delta/snapshot interpretation for each turn. When the DOM is damaged, conflicting complete interpretations are rejected before syntax recovery can turn concatenated snapshots into fabricated source. Repeated real deltas and complete snapshots remain intact.

See [4.9.9 mode ambiguity behavior and validation](docs/RELEASE_4.9.9.md) and the recovery pipeline below. Agent/Protocol wire contracts and consumer dependencies remain unchanged.

## Reverse Proxy 4.9.8 — lossless contract recovery and raw browser responses

Agent v2, tool calls and structured JSON share bounded syntax recovery. The parser preserves file formatting and rejects ambiguous guesses, duplicate keys, multiple payloads and truncated data. Same-session repairs preserve known actions and unaffected arguments, stop when no progress is made and stay under the existing cumulative attempt/deadline budget. Ajv validates caller schemas before dispatch without modifying values.

Buffered contracts can use the original CDP network response when the full submitted prompt matches and a completed stream has an already trusted extraction profile. HTML/Markdown damage no longer forces a model retry in that case. A CDP completion race that could lose buffered bytes is fixed. Artifact hydration requires a matching current-response file and preserves explicit empty content.

See [4.9.8 recovery behavior, limits and validation](docs/RELEASE_4.9.8.md). The historical release entries below describe earlier behavior; current Agent v2 remains the authoritative wire contract.

## Reverse Proxy 4.9.7 — WebChat Agent contract recovery

Agent-contract v2 now tolerates deterministic WebChat JSON wrappers without extracting JSON from prose, and repair turns keep only the original user task, invalid candidate and structural route/tool data instead of replaying typed workspace/orchestrator context. This prevents repeated `agent_contract_invalid` loops observed with Gemini Web while preserving fail-closed contract validation.

This release pairs with Agent CLI **0.83.15** and KITT Protocol **0.9.0** and does not change the wire contract.

## Reverse Proxy 4.9.6 — bounded full-content logging

Debug logging with `--log-content full` now respects the existing structured-log depth bound, preventing cyclic runtime objects such as request lifecycle/timer state from causing `Maximum call stack size exceeded`. Full prompt/response content remains visible inside the bounded structure.

This release pairs with Agent CLI **0.83.15** and does not change the Agent/Protocol wire contract.

## Reverse Proxy 4.9.5 — baseline browser pressure admission

Headed browser startup no longer makes the first named Agent session unusable when the Chromium baseline already exceeds the configured RSS threshold. The proxy admits exactly one initial named session in that baseline-only case, while preserving strict session-count limits, protected-session behavior and LRU recycling of idle named sessions.

This release pairs with Agent CLI **0.83.15** and does not change the Agent/Protocol wire contract.

## Reverse Proxy 4.9.4 — transport-only Agent boundary

The Agent/WebChat boundary remains the canonical agent-contract v2, but the Reverse Proxy no longer acts as an execution-policy authority. It transports route, tools, typed context and correlation metadata; validates the canonical response shape and caller-supplied tool schema; converts `use_tool` into native OpenAI `tool_calls`; and preserves bounded same-session repair for invalid model output.

Route-specific tool filtering, mutation/discovery/validation inference, local `host_execution` interpretation, checkpoint enforcement and completion gating now stay with the Agent host. Existing structured correlation logs remain unchanged, and local health continues to use the existing session/capacity states rather than a new tracing or lifecycle framework.

This release pairs with Agent CLI **0.83.8** and KITT Protocol **0.9.0**.

## Reverse Proxy 4.9.3 — canonical Agent contract

The Agent/WebChat boundary now accepts one semantic response shape only: the agent-contract v2 JSON object with explicit `action`, `tool`, `tool_input`, `content`, `reasoning_summary` and `loop` fields. A single fenced `json` block remains accepted as transport tolerance, but legacy `<kitt-tool>`, bare runtime-operation objects, `tool_name/arguments` aliases, malformed write-file repair, and plain-text final-response fallback are no longer reinterpreted as valid Agent actions.

OpenAI transport remains structural: `tools/tool_choice`, `tool_calls`, `role=tool`, `kitt_context` and `kitt_meta` are the only supported Agent↔Proxy path. Invalid model output stays recoverable through the existing bounded retry/continue flow and preserves the browser session.

## Reverse Proxy 4.8.0 — typed host evidence and planning transport

## 4.9.1 — retain evidence in built-in UI repairs

Tool/JSON repairs preserve the original task, typed context and candidate under the same bounded lifecycle.

## 4.9.0 — bounded gateway lifecycle

[Lifecycle, API behavior and operational limits](docs/GATEWAY_LIFECYCLE_4.9.0.md): bounded repairs, exact streaming, generation-aware context, cumulative usage and process-scoped idempotency.

Reverse Proxy 4.8.0 consumes `HostExecutionState` v1 from the executing Agent host. It no longer parses `HOST_STATUS`, `ERROR:` or command-name regexes to decide verification success. It binds facts to conversation/turn metadata, rejects untrusted workspace host-state segments and keeps final responses blocked while the host reports pending tasks, children or verification.

Capability discovery advertises host evidence, bounded task plans, subagent reports and hierarchical request correlation. The existing roles DISCOVER/ARCHITECT/IMPLEMENT/VERIFY/REVIEW are preserved; role metadata grants no authority. Optional `parent_request_id` and `task_id` survive the structural request pipeline. Proactive checkpoints occur halfway through longer action cadences while the global turn budget remains host-owned.

Update together with Agent CLI **0.82.0** and Protocol **0.7.0**. `agent-loop` requires typed host facts; missing or mismatched facts produce an actionable HTTP 400. The proxy remains a transport/provider gateway: it does not execute the task DAG, own memory, grant approval or spawn children.

## Reverse Proxy 4.7.5 — persistent bounded-loop checkpoints and compact recovery

Reverse Proxy 4.7.5 fixes the agent-loop action budget so checkpoints are scoped to a bounded loop rather than inferred from global tool-call multiples. Checkpoint tool responses are now marked structurally, allowing the next host result to start a new loop epoch with `LOOP_ACTION_COUNT=1` instead of incorrectly clearing/retriggering checkpoints based on `HOST_ROUND_TRIP_COUNT % budget`.

The orchestrator now exposes `LOOP_INDEX`, `LOOP_ACTION_COUNT`, `LOOP_ACTION_BUDGET` and `TURN_TOOL_CALL_COUNT` while retaining the total host round-trip counter for diagnostics. Contract-failure bootstrap reinjection also uses a bounded recent-validation window and cooldown, preventing a small number of early malformed responses from forcing repeated full-context bootstrap requests.

This release pairs with Agent CLI **0.81.1**.

## Reverse Proxy 4.7.4 — protocol-owned request metadata and immutable releases

Reverse Proxy 4.7.4 keeps the shared Protocol `KittRequestMetadata` wire shape for `kitt_meta`, including optional session identity. K.I.T.T. execution context remains accepted through typed `kitt_context` only, tools come from the native `tools` schema only, and route/correlation metadata stays outside provider-visible logical history. Legacy `[KITT TURN CONTEXT]` and textual `Tool Contract:` parsing remain removed.

`conversation_id`, `turn_id` and the unified request ID are logged as structured correlation metadata and are stripped before provider-visible logical history. Typed context likewise remains outside WebChat history, preserving the browser conversation while retry/continue flows reuse the same execution metadata and usage accounting.

Release automation now treats semantic tags as immutable: if the current package version already matches the latest release, the validated SHA must be exactly the SHA behind that tag. Unpublished commits at an already released version fail fast and require a new version bump instead of retagging or silently skipping the release.

The agent-contract regression suite uses structural fixtures for discovery-first execution, mutation/validation gating, bounded-loop checkpoints, summarize isolation and repair continuity. This release pairs with Agent CLI **0.80.5**, Protocol **0.5.2** and Memory **0.6.1**.

## Reverse Proxy 4.7.0 — LLM-first agent-contract v2

Reverse Proxy 4.7.0 introduces the internal **agent-contract v2** and the language-neutral `agent-loop` used by Agent CLI 0.79.0. The original user request remains verbatim and WebChat is the only component that interprets its natural language, scope and intent; the proxy no longer strengthens routes from Portuguese/English keywords or project-domain heuristics.

Each agent-loop response carries a bounded loop state with `objective`, `completion_criteria`, `status` and `validation_summary`. The proxy counts completed host round trips and requires a model checkpoint every configured action budget (default **4**) before another slice continues. Checkpoints are evidence-driven: they are based on actual host observations, not model claims.

Safety remains deterministic. The first mutation cannot occur before repository evidence, tools remain allowlisted and schema-validated, policy/approvals stay host-side, and any mutation requires a successful build/test/check after the latest write before `final_response` when validation is available. Contract v1 compatibility is intentionally not retained; Reverse Proxy 4.7.0 is paired with Agent CLI 0.79.0.

## Reverse Proxy 4.6.8 — WebChat conversation hydration

Fresh browser-backed WebChat sessions now receive the prior caller-visible API conversation exactly once before the current actionable turn. Existing stateful browser sessions continue with delta-only prompts, preventing both lost conversational context and repeated-history superprompt growth.

System/developer instructions remain on the dedicated protocol path rather than being replayed as simulated chat messages, and the current user/tool turn is excluded from the hydration envelope to avoid duplication.

## Reverse Proxy 4.6.7 — validation evidence gate

Agent mutation turns now carry validation state explicitly. A final response is rejected until a host build/test/check reports `HOST_STATUS: success` after the latest mutation; failed validation resets completion eligibility instead of allowing the model to claim that the project was tested successfully.

## Reverse Proxy 4.6.6 — recoverable model-response failures

Reverse Proxy 4.6.6 keeps browser-backed Agent sessions alive when the upstream model repeatedly returns an invalid Agent contract. After the built-in repair attempts are exhausted, the proxy returns a structured recoverable `agent_contract_invalid` response with `recovery_action: "continue"` instead of misclassifying the event as a terminal `502/api_error`.

The named `X-Kitt-Session-Id` session is preserved so Agent CLI can offer **Continue / Retry** without reconnecting or replaying already completed host tools. Non-recoverable network, browser and protocol failures keep their normal error semantics.

## Reverse Proxy 4.6.5 — synthetic tool-call continuity

Reverse Proxy 4.6.5 preserves Agent contract tool round trips when an OpenAI-style assistant message contains both a native `tool_calls` entry and public progress text in `content`. Contract-generated call IDs are normalized back into KITT tool-result evidence before the browser executor sees the next turn, preventing false `invalid_tool_request: unknown tool_call_id` failures.

Reverse Proxy 4.6.4 prevents superprompt amplification in browser-backed Agent sessions. Generated Agent persona and the textual Tool Contract are no longer re-forwarded after the proxy has received the real tool schema structurally.

Mutation turns use a compact deterministic execution plan: `discovery -> mutation -> validation`. Only one host action is requested for the current phase before waiting for its result. Trusted orchestration retained from the Agent is capped at 4 KiB, while workspace/tool schemas are sent only when the session bootstrap changes; later turns remain deltas.

Contract repair remains isolated from the workspace bootstrap. Valid Gemini-style `use_tool` responses that omit nullable `content` or `reasoning_summary` are normalized locally instead of causing repair loops.

## Reverse Proxy 4.6.3 — staged agent contract

Reverse Proxy 4.6.3 removes the superprompt regression in browser-backed agent execution. The first request for a stable Agent session is a bounded bootstrap with the active tool schema and workspace evidence; later tool round trips use compact delta context and rely on the named session for already-supplied bootstrap state.

Contract repair no longer resends the original workspace/task payload. Valid `use_tool` responses may omit nullable `content`/`reasoning_summary`, and common `tool_name`/`arguments` aliases are normalized locally before schema validation. Broad implementation turns preserve the Agent's structured discovery phase, forcing one repository observation before mutation and then progressing one host action per round trip.

## Reverse Proxy 4.6.1 — reasoning-summary transport

Reverse Proxy 4.6.1 preserves the validated agent-contract `reasoning_summary` on native OpenAI tool-call completions instead of discarding it when `action="use_tool"` is transformed into `tool_calls`. The summary remains bounded by the existing two-sentence / 400-character contract and is public progress metadata, not chain-of-thought.

This allows Agent CLI 0.77.2+ to show what the model is doing and why while keeping the concrete tool/operation as a separate technical detail.

## Reverse Proxy 4.5.0 — agentic WebChat reliability

Reverse Proxy 4.5.0 aligns browser-backed providers with the Agent CLI 0.77 execution model:

- discovery-first turns expose and validate whether a read-only repository observation has completed before mutation is accepted;
- WebChat response waiting is activity-aware: visible streaming state, response-text changes and DOM mutations refresh the inactivity budget;
- the configured UI response timeout is treated as inactivity protection, while a larger bounded absolute ceiling prevents infinite waits;
- Gemini response extraction keeps the broader selector set introduced in 4.4.2;
- managed browser-service startup retains the 330-second readiness budget for login/profile startup.

This does not make UI automation equivalent to an official streaming API. When a native provider API is configured, its token stream remains the preferred low-latency transport; WebChat remains a resilient compatibility path.

## Reverse Proxy 4.3 — resident control and lower contention

Version 4.3 keeps the existing per-service OpenAI-compatible endpoints but moves lifecycle discovery onto an optional resident loopback control process:

- `kitt-reverse-proxy control ensure --json` starts the lightweight control server on `127.0.0.1:2999` by default; override with `KITT_REVERSE_PROXY_CONTROL_PORT`.
- Agent CLI 0.73+ uses that channel for plugin/profile/service operations and falls back to the existing CLI contract when necessary.
- Chat execution and the dedicated browser-automation page use independent bounded serial queues, so browser inspection does not wait behind an unrelated provider response while ordering remains strict within each lane.
- `service stop --all` terminates independent services concurrently instead of accumulating per-process shutdown deadlines.
- `npm run benchmark:control` measures cold control bootstrap and warm p50/p95/p99 request latency without contacting a model.

The resident control process does not own authenticated browser sessions; service processes retain browser/profile isolation. This deliberately reduces CLI/process bootstrap overhead without weakening the existing profile ownership boundary.

## Reverse Proxy 4.4.2 — UI response and managed-start reliability

Patch 4.4.2 fixes two timeout paths exposed by long-running WebChat sessions and managed browser startup:

- the first useful UI delta now uses the configured `--ui-response-timeout` budget instead of an independent hard 90-second cutoff, so a configured 180-second response window is honored end to end;
- Gemini response discovery covers current `message-content` and nested markdown DOM variants while retaining the existing provider-specific selectors;
- managed `service start` readiness allows up to 330 seconds for visible Chromium and human-login bootstrap before declaring startup failure.

These changes keep the OpenAI-compatible API and control-plane schema unchanged.

## Reverse Proxy 4.4.1 — lifecycle hardening

Patch 4.4.1 hardens the multi-process lifecycle without changing the public model APIs:

- managed services and BrowserHosts persist a process fingerprint derived from process start/command identity; a recycled PID alone is never authority to terminate a process;
- profile/instance registry mutations use cross-process locks and service lifecycle operations use a broader lock, preventing lost JSON updates and competing start/stop allocation;
- service startup is published only after the spawned HTTP listener answers its liveness endpoint; failed starts roll back their owned child processes;
- pre-4.4.1 instance records without a process fingerprint are treated as stale rather than trusted for termination;
- session shutdown propagates cancellation and uses a bounded drain window so an executor that ignores cancellation cannot block shutdown indefinitely.

## Reverse Proxy 4.4 — browser-host pooling and resource budgets

Version 4.4 completes the performance roadmap without changing the OpenAI-compatible service endpoints:

- Managed services may share one native Chrome BrowserHost only when they use the same named browser profile. Different credential/user-data directories are never combined.
- Gemini and ChatGPT remain on the dedicated human-authentication bootstrap path and are excluded from BrowserHost pooling.
- BrowserHost startup is opportunistic: if stable Chrome/CDP is unavailable, the first service falls back to the existing process-owned browser path.
- Session eviction is resource-aware: idle LRU candidates may be reclaimed for max-session pressure, browser-page pressure, or configured process RSS pressure. Busy sessions and sessions awaiting client tool results remain protected.
- The resident control plane keeps its ServiceManager and instance registry hot in memory; external file mutations are detected by mtime and atomic persistence remains authoritative.
- Native Chrome CDP polling now backs off during long manual-authentication waits and samples quickly again when the expected target returns.
- `npm run benchmark:runtime` reports live service/process-tree memory on Linux (PSS when available), BrowserHost topology and service-list latency. With `KITT_BENCH_TARGET=<provider|url>` it manages 1/2/4-service scenarios, measuring startup-to-ready, named-session creation p95, browser inspect p95 and shutdown; `KITT_BENCH_API_KEY` (or `PROXY_API_KEY`) is honored automatically.

Resource knobs:

```text
PROXY_MAX_BROWSER_PAGES=12
PROXY_MAX_RSS_MB=768
PROXY_BROWSER_HOST_POOL=true
```

The RSS signal is the reverse-proxy process RSS; browser page count is used as the portable browser-pressure signal. The runtime benchmark additionally measures the Linux process tree so Chromium cost is visible during performance testing.

## 4.6.2 code-hygiene gate

TypeScript validation now rejects unused locals and unused parameters in production/test compilation. This keeps stale transport, provider and browser-runtime branches from accumulating silently as the plugin architecture evolves.
