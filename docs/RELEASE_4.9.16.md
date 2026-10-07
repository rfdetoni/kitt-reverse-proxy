# K.I.T.T. Reverse Proxy 4.9.16 — Agent-owned managed services

Reverse Proxy 4.9.16 adds lifecycle and logging metadata for instances launched by KITT Agent CLI.

## Managed logging

The control-plane service start contract accepts:

- `log_level` / `--log-level`
- `log_content` / `--log-content`
- `log_file` / `--log-file`

The service manager forwards those settings to the spawned proxy process. When the Agent supplies its own log file, the managed service derives a sibling file named `reverse-proxy-<instance>.log`; Agent and Proxy therefore do not concurrently append to the same file.

Logging settings are stored with the instance and preserved by managed restart.

## Process ownership

The control-plane service start contract also accepts `owner_pid` / `--owner-pid`.

A managed proxy watches that PID and performs the normal graceful server/session shutdown when the owner disappears. This is the crash-safe fallback to the Agent's explicit `service.stop` call during clean TUI shutdown.

Only services started with an owner PID are owner-managed. Standalone/manual services remain independent.

## Shared Browser Host

Browser-host pooling remains profile-owned. The shared Browser Host intentionally does not inherit one service owner's PID, because several managed services may share it. Normal service stop already terminates the browser host once no registered instance still uses it.

## Compatibility

The OpenAI-compatible API and Agent contract v2 are unchanged. This is a control-plane/process-lifecycle extension, paired with Agent CLI 0.84.2.
