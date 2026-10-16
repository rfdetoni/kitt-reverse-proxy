# Reverse Proxy 5.4.5 — fresh WebChat capture after prompt reflow

The 5.4.4 ChatGPT UI log showed a successful prompt submission, a CDP `no_matching_request` fallback, no assistant-role/turn selectors, and many unrelated valid JSON objects in page text; no unambiguous answer was recoverable. Agent CLI correctly received `ProviderProtocolError` and executed no unverified model action.

The DOM strict-frame selector now prefers regions proven to follow exactly one newly rendered user prompt, rather than mixing unrelated unscoped JSON from a long history. A bounded fallback anchors on 24/16/12/8 trailing words, each still requiring >=96 characters and a pre-submit count delta. It does not select one of two conflicting fresh frames, accept an old prompt example, relax CDP correlation, or automatically resend the prompt.

The regression suite includes a noisy history plus fresh boundary, a reformatted long prompt, and conflicting fresh responses. This is a defensive mitigation; without a fresh boundary or correlated CDP result, capture intentionally fails closed.
