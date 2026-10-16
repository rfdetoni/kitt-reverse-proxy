# Reverse Proxy 5.4.6 — fresh DOM response prompt-echo exclusion

Fixes a safety edge in the 5.4.5 current-turn DOM fallback: a model reply may echo a JSON example that appears in the submitted prompt. Even with a proven boundary, semantically identical prompt JSON is now always excluded from tool-response selection. The existing baseline and uniqueness checks remain, and ambiguous output still fails closed. Adds one targeted regression test and updates package/lock versions. No new dependency or wire schema.
