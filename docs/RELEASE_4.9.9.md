# Reverse Proxy 4.9.9 — stream mode ambiguity guard

This patch completes the [4.9.8 recovery pipeline](RELEASE_4.9.8.md) with a per-turn check for delta versus cumulative-snapshot ambiguity.

A profile learned from short, single-piece responses may not distinguish those modes. If a later response contains cumulative snapshots but the profile uses delta mode, concatenating the snapshots produces malformed JSON. Syntax recovery could then interpret the concatenated prefixes as source text. With a damaged DOM, that interpretation must never become a file or contract payload.

Active profiles now retain the alternative extraction mode for the same correlated response frames. When the DOM cannot provide a payload valid without syntax repair, raw selection rejects a different complete alternative that is valid without syntax repair. Agreement obtained only by repairing both DOM and raw text cannot prove the extraction mode. Equivalent alternatives remain safe. A malformed alternative does not override a complete snapshot, and repeated real deltas remain intact. Strictly valid DOM/raw agreement can still confirm the selected mode; conflicting valid DOM/raw payloads remain recoverable failures.

The guard uses the existing 409 `agent_contract_invalid` / `continue` surface and drops trust through the existing verification-failure path. Repair anchors also retain complete nested values observed before the first ambiguous quote branch, even when later corruption makes the parent object ambiguous. A known file path cannot disappear from continuity checks because its content is corrupted. No Agent/Protocol wire fields, consumer versions or dependencies change.

Validation: 176 Proxy tests including replay of the reproduced mode-confusion case, correct cumulative-snapshot extraction and path preservation across parent ambiguity; typecheck/build, fast installer build, installer syntax, package contents and dependency audits. Agent/Protocol/schema compatibility checks from 4.9.8 remain applicable. Authenticated live provider sessions are not exercised.
