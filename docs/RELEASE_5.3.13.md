# Reverse Proxy 5.3.13 — reduce repeated DOM observer setup

- Reuse a page-bound MutationObserver while waiting for the current model turn.
- Disconnect after two seconds with no subscribers to avoid idle page overhead.
- Preserve existing fallback timeout, abort handling, DOM provenance checks and 500 ms contract scan.
- Sync package.json and package-lock.json version to 5.3.13.
