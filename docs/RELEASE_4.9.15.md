# Reverse Proxy 4.9.15

## Passive request correlation

The request-match deadline begins immediately before clicking Send or pressing Enter, after composer filling and button readiness. It no longer expires during a slow composer update. Network tracking requests inline POST bodies up to the existing 2 MiB discovery limit; when Chromium omits a body but reports hasPostData, the tap reads the already submitted body with Network.getRequestPostData. It never replays the request. Response/finish/failure metadata arriving during that read is correlated to the same turn; cancelled and replaced turns cannot receive late bodies. Both inline and retrieved bodies and the pending candidate count are bounded. Host policy, exact endpoint/status validation and full submitted-prompt matching remain required.

## RPC source extraction

The DOM-trained extractor considers individual positional array leaves and bounded nested JSON strings. Learned profiles retain exact array indices and relative JSON-string decoding paths, so metadata is never concatenated with the reply. Named answer fields keep their original JSON contract source. Limits cover traversal, nesting, decoded bytes and candidates; malformed or changed envelopes fall back through existing reader health handling. Decoder paths participate in trust identity and are copied at the health boundary.

Raw recovery still requires a previously trusted profile, full request correlation, successful stream completion, no tap failure and a valid complete contract. Conflicting valid network/DOM contracts fail recoverably. The DOM remains authoritative during profile learning. No missing contract semantics are invented.

## Human ChatGPT login

ChatGPT now selects the existing system-Chrome human-authentication bootstrap, opening the documented https://chatgpt.com/auth/login page in the dedicated profile. Playwright connects only after the browser returns to the exact provider origin outside auth/login/signin routes and no Google/OpenAI auth popup remains. Managed ChatGPT services, like Gemini, no longer pool a BrowserHost that would attach before authentication. Explicit user-owned CDP connections remain under user ownership. The timeout message identifies the actual provider rather than always naming Gemini.

Google documents that sign-in may be refused for software-controlled browsers (https://support.google.com/accounts/answer/7675428); OpenAI documents the login URL and using the account's original sign-in provider (https://help.openai.com/en/articles/7426629-why-cant-i-log-in-to-chatgpt). This change reuses a human authentication flow, with no stealth flags, login automation or security-check bypass. Chrome stable must be installed or configured with KITT_CHROME_BIN. Session/profile contents are never copied between browser profiles.

## Validation and limits

Two new regression cases failed before correction: positional encoded RPC source extraction and an omitted form body whose response finishes before body retrieval. Local TypeScript checks, production build and 200 tests pass, including stale-turn exclusion, resource limits and unchanged named JSON source. The existing Chromium gate adds a real UI-to-CDP fixture with a deliberately slow composer, omitted POST notification bodies, XSSI/length-framed RPC replies, fragmented UTF-8 and a second turn whose DOM damages the contract; it asserts one browser request per turn.

The supplied Gemini logs report no matching capture, but contain no live browser request/response bodies. The generic local RPC fixture does not authenticate with Google or establish that every current Gemini response layout is supported. The new Agent logs separately identify endpoint trust missing for a manually selected managed service on port 3001; that fix belongs to Agent CLI.

Lifecycle regressions reproduce ChatGPT selecting the automated browser before correction and assert human launch policy, pool exclusion, login-route/popup gating and exact-origin return. They do not authenticate a live account, so provider-side acceptance is not guaranteed by the fixture.

CI and Docker checks also run on fix/** branches, retaining their existing test/audit gates and main/PR triggers. This permits validation before main promotion when PR creation is unavailable in the connector.
