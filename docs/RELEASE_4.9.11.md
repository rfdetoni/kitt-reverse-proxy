# Reverse Proxy 4.9.11

Four reproduced boundaries are corrected:

- Failed `Network.enable` attachment releases its CDP session and listeners. Concurrent initialization creates one session; detach and reconnect execute in order after pending attachment.
- Live `Network.dataReceived` bytes wait behind the prefix returned by `Network.streamResourceContent`. Pending bytes count toward the turn budget and are discarded on failure/cancellation; late replies cannot contaminate the next turn.
- Redirected requests, changed final response URLs and non-2xx HTTP responses cannot become trusted raw contracts. DOM fallback and existing diagnostics remain available.
- Streaming and discovery SSE parsers remove only the one optional protocol space after `data:`. Source indentation, trailing spaces and multiline data survive LF, CR and fragmented CRLF delimiters, including fragmented UTF-8.

The new `npm run test:browser` gate uses real Chromium and a local HTTP/SSE fixture. Its first healthy DOM response earns a profile; subsequent turns prove raw completed contracts remain intact with damaged HTML. CI installs Chromium and runs this gate before promotion. Local Chromium download was truncated by the execution environment; browser evidence comes from CI. Deterministic regressions reproduce attachment leaks, reversed chunks, invalid-source acceptance and whitespace loss before the fixes.

Cancellation, manual intervention, incomplete streams, strict contract validation, profile trust and competing extraction safeguards remain in place. Redirected raw streams fall back to the DOM rather than inheriting trust from the original URL. Authenticated live provider sessions are not covered. Agent/Protocol wire contracts and consumer locks are unchanged; package and npm lock versions are 4.9.11.
