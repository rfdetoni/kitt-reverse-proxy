# Reverse Proxy 5.4.6 — DeepSeek Web answer capture

## Fix

- DeepSeek provider plugin **1.1.0** (selector schema v2) now targets the
  `.ds-assistant-message-main-content` final-answer element, not the
  generic `.ds-markdown` selector (which can also match DeepThink reasoning).
- Provider SDK accepts optional `responseExcludeSelectors`. The UI collector,
  pre-submit baseline, submission confirmation and active snapshot reader all
  reject elements inside provider-declared thinking/reasoning ancestors.
- Preserve the existing fail-closed contract: if no final assistant answer is
  detectable, never substitute reasoning text, old answers, unverified CDP
  traffic or raw JSON fragments. The host still owns schema validation.
- Adds synthetic DOM regression tests for: thought+answer, thought-only,
  active snapshot re-read and plugin selector specificity.

## Observations from user-provided DeepSeek 5.4.5 log

- Browser composer write/send succeeded (about 29k chars).
- CDP tap matched but was not verified (profile_mismatch); DOM won.
- The first text captured was about 18.5k chars of thinking rather than
  the final JSON action; two repair attempts likewise captured non-JSON.
- Browser RSS exceeded the configured 768 MiB admission threshold
  (~817 MiB observed), independent of the response selector problem.

## Operator guidance

- Use the DeepSeek model alias `deepseek-web`, a dedicated authenticated
  browser profile, and `--log-content metadata` for regular operation.
- Check container/browser RSS and raise `--max-resident-rss-bytes` only
  if the host has headroom, rather than disabling isolation.
- If DeepSeek changes its markup, capture a **redacted DOM fixture** of the
  answer/thinking wrappers; avoid a broad `.ds-markdown` fallback.
- This change is regression-tested but live authenticated DeepSeek CDP/DOM
  verification still requires an operator browser session.
