# Reverse Proxy 5.4.2 — exclude rendered prompt examples and await generation

The supplied 5.4.1 incident captured the prompt's `api_id` report example as a 319-character response while ChatGPT was still generating. Whitespace-only text matching missed the rendered JSON layout. The resulting contract repair immediately collided with the active Stop control.

Prompt and baseline exclusion now compare strictly parsed JSON values in addition to exact text, preserving whitespace inside string values. A fresh response after the submitted prompt may still intentionally repeat a tool example. Independent DOM completion requires stable response text and an idle generation; a balanced intermediate JSON block cannot end an actively generated answer.

Before collecting every response baseline and before editing/sending the next prompt, the executor waits for the preceding generation to stop, within the configured UI response timeout and with cancellation. Taking the baseline after this wait prevents a late previous answer from becoming the next response. Busy timeout and cancellation preserve the draft and do not send or replay a prompt. Shared Agent v5 validation, tool authorization and exact-data repair rules remain unchanged.

Validation: the actual logged candidate is rejected against its original prompt; 268 unit tests and 14 Chromium integrations cover reformatted prompt examples, intermediate JSON during generation, cancellation/draft preservation, one send after idle and exclusion of a previous answer completed during that wait. No authenticated live provider session was used.
