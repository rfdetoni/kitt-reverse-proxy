# Reverse Proxy Control Plane

## Purpose

The control plane owns local reverse-proxy process discovery and lifecycle. Agent CLI is a client of this contract and must not inspect operating-system process tables or duplicate the provider-plugin catalog.

## Responsibilities

- `ProfileRegistry`: named Chromium profile metadata, legacy profile import and provider association.
- `InstanceRegistry`: hot cached active-process descriptors with atomic persistence and external-mtime invalidation.
- `ServiceManager`: target resolution, profile-scoped start serialization, automatic port allocation, BrowserHost ownership and cross-platform process lifecycle.
- resident control server: low-overhead loopback lifecycle API used by Agent CLI.
- `runControlPlaneCli`: stable CLI compatibility boundary consumed by humans and KITT components.

The provider registry remains the source of truth for connection plugins.

## CLI contract

All automation-facing commands support compact JSON:

```text
kitt-reverse-proxy plugins list --json
kitt-reverse-proxy profiles list --json
kitt-reverse-proxy profiles create <name> [--provider <id>] --json
kitt-reverse-proxy profiles remove <id> [--delete-data] --json
kitt-reverse-proxy service list --json
kitt-reverse-proxy service start <provider|url> [--profile <id>] [--id <id>] [--port <n>] --json
kitt-reverse-proxy service stop <id>|--all --json
kitt-reverse-proxy service restart <id> --json
```

Responses use `schema_version: 1`.

## Multi-instance topology

A service instance owns one provider target and one local API endpoint. Multiple instances may run concurrently on different ports. For managed non-Gemini services, multiple instances may reference the same named browser profile only through the 4.4 profile-scoped BrowserHost; service processes never open that user-data directory independently. Profiles that are not hosted remain exclusive to one service process.

Agent-specific roles such as context, coding and validation do not belong in this repository. Agent CLI binds its roles to instance endpoints, preserving Clean Architecture ownership.

## Resource policy

The control plane has a lightweight resident loopback process that keeps lifecycle state hot while persisting registries atomically for crash/restart recovery. Service startup chooses the first free loopback port in 3000-3099; browser/model traffic stays in the service/browser-host data plane rather than the control server.

## Resident control server (4.3)

The control plane now has a lightweight optional resident process. It binds only to host loopback and exposes `GET /healthz`, `POST /v1/control` and a local shutdown endpoint. `control ensure` starts it on demand; no browser is launched by the control process.

The machine-readable actions mirror the CLI contract:

- `plugins.list`
- `profiles.list`, `profiles.create`, `profiles.remove`
- `service.list`, `service.start`, `service.stop`, `service.stopAll`, `service.restart`

This removes repeated Node bootstrap/module-loading cost for Agent CLI management calls while keeping CLI commands as a compatibility boundary. Browser-backed service instances remain independent processes in 4.3 so Chromium user-data ownership remains exclusive and credential-safe.

### Concurrency

Each logical session owns two bounded serialization lanes: the provider chat lane and the separate browser-automation page lane. Operations remain ordered inside a lane, but an automation inspection/click does not block behind a long provider response. Session busy/idle state is reference-counted across both lanes, and eviction/shutdown waits for both queues.

Multi-service shutdown runs concurrently with the same per-instance graceful-then-forced termination policy.

## 4.4.1 lifecycle ownership

Lifecycle authority is stronger than a numeric PID. Every managed service and BrowserHost persisted by 4.4.1 carries a process fingerprint derived from process start identity and command identity. Stop, stale-record reconciliation and orphan cleanup signal a process only when the currently running OS process matches that fingerprint. Legacy records without this identity are discarded and never killed.

Profile and instance read/modify/write operations use short cross-process filesystem locks. Start/stop/restart additionally share a lifecycle lock, so separate CLI and resident-control processes cannot overwrite registry state or race for the same service/CDP port. Atomic rename remains the final persistence step.

Service start is transactional from the caller perspective: the child must expose /healthz before its instance record is published. A child that exits or fails to bind is rolled back together with any BrowserHost created only for that start attempt.

Session-manager shutdown rejects new work, propagates an AbortSignal to accepted work and waits only a bounded grace period before releasing browser resources. Third-party executors can no longer block process shutdown forever.

## 4.4 BrowserHost topology

The resident control process now also coordinates an optional profile-scoped BrowserHost for managed services. A BrowserHost owns exactly one Chromium user-data directory and loopback CDP endpoint. Multiple reverse-proxy services may reuse that host only when they explicitly resolve to the same profile; each service creates its own CDP page and each logical KITT session continues to receive isolated tabs.

Credential boundaries are invariant:

- different profile directories never share a BrowserHost;
- Gemini is excluded from pooling so its human-only Google authentication bootstrap is preserved;
- if a shared host cannot start, the first service falls back to the previous process-owned browser path;
- a profile already owned by a non-pooled/legacy service remains exclusive;
- per-profile service starts are serialized to prevent concurrent host/profile races.

When the last service using a BrowserHost stops, the control plane terminates that host. Stale instance records are reconciled and orphan BrowserHost wrapper processes are reaped on control-plane lifecycle operations.

## 4.5 agent-contract and response-liveness boundary

Agent CLI 0.77 can mark a broad mutation turn as discovery-first. The reverse proxy preserves that intent in its agent-contract state, records whether a read-only repository tool result has completed, and rejects a non-exploration action until that observation exists. The Agent remains the owner of planning and milestones; the proxy only validates the wire contract.

UI response waiting now distinguishes inactivity from total wall-clock duration. Streaming indicators, response-text changes and DOM mutations count as progress and refresh the configured inactivity window. A separate bounded absolute ceiling still terminates a chat that never reaches a usable final response. This protects long visible reasoning without permitting an unbounded browser wait.

## Resource-aware session policy

Session admission now considers the normal max-session limit plus browser-page and resident-RSS budgets. Only idle, non-default sessions that are not awaiting a tool result are recyclable. Time-based cleanup remains in place, but pressure-based cleanup can reclaim an idle LRU session before the idle timeout.

The capacity snapshot reports `browser_pages`, `max_browser_pages`, `resident_rss_bytes`, `max_resident_rss_bytes` and `eviction: resource_lru_idle`.

## Performance verification

`npm run benchmark:runtime` is non-destructive by default and snapshots current managed services. Set `KITT_BENCH_TARGET` to enable managed 1/2/4-service scenarios. Managed runs use disposable profiles, measure startup-to-ready, process-tree PSS/RSS on Linux, BrowserHost sharing, named-session creation p95, browser inspect p95 and shutdown, then stop services and delete benchmark profiles. Authenticated services reuse `KITT_BENCH_API_KEY` or `PROXY_API_KEY`.

