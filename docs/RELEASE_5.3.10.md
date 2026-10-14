# Reverse Proxy 5.3.10 — response freshness under WebChat DOM drift

Incident: 2026-10-14, reverse-proxy 5.3.9, request
`39ff530c93cd4896930e23697ebd2256`.

- Prompt: 64,071 characters; ChatGPT accepted the send.
- At timeout: zero assistant and structural turn nodes; three visible
  `K2/END` markers; one compact candidate, none provably fresh.
- DOM samples: 5, maximum 131,072 characters; Agent received 0 chunks.
- Failure was before protocol parsing, not an E_HEADER recurrence.

## Fix

- Install a bounded native MutationObserver on the provider DOM before
  submission; track candidate envelopes in recently changed/added nodes.
- Keep user/composer exclusion, prior DOM baseline, prompt-echo rejection,
  unique-frame rule and canonical KAP parsing before completion.
- Disconnect observer after response (including errors/cancellation).
- Real Chromium regression covers a 131 KiB overflow of the body text
  fallback, no assistant selectors, and user-provided KAP examples.

The probe does not rely on or require unsupported private provider APIs.
Live authenticated ChatGPT Web retesting is still necessary; if a provider
does not render the answer anywhere in the observed DOM, transport still
fails closed rather than accepting a stale frame.
