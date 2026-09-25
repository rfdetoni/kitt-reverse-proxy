# Reverse Proxy Control Plane

## Purpose

The control plane owns local reverse-proxy process discovery and lifecycle. Agent CLI is a client of this contract and must not inspect operating-system process tables or duplicate the provider-plugin catalog.

## Responsibilities

- `ProfileRegistry`: named Chromium profile metadata, legacy profile import and provider association.
- `InstanceRegistry`: active reverse-proxy process descriptors.
- `ServiceManager`: target resolution, profile exclusivity, automatic port allocation and cross-platform process lifecycle.
- `runControlPlaneCli`: stable CLI boundary consumed by humans and KITT components.

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

A service instance owns one provider target, one local API endpoint and one browser profile while it is running. Multiple instances may run concurrently on different ports. A single browser profile may record successful use with multiple providers, but 4.2 deliberately prevents simultaneous independent processes from opening the same user-data directory.

Agent-specific roles such as context, coding and validation do not belong in this repository. Agent CLI binds its roles to instance endpoints, preserving Clean Architecture ownership.

## Resource policy

There is no resident control-plane daemon. Registries are small JSON files and process health is sampled only when requested. Service startup chooses the first free loopback port in 3000-3099 and keeps provider browser work isolated from control-plane metadata.
