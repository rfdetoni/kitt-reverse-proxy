# Reverse Proxy 5.1.1

Contract validation now detects competing KAP directives even when an earlier malformed line would stop parsing. The Gemini response containing `STRINGKITT/1` followed by another ACTION is rejected with recoverable HTTP 409 before consuming an upstream repair attempt. A repair cannot choose between TOOL and FINAL.

The existing continuity extractor supplies this check and skips literal TEXT content. Unique syntax repair and stable-field protection retain their existing behavior. Contract v4 and KAP/1 are unchanged; Protocol does not need a version bump.

Validation: expanded existing HTTP recovery regression reproduces the extra repair attempt on 5.1.0 and verifies one attempt on the corrected code. The Proxy suite contains 218 tests. Browser submission code is unchanged from the enabled-button fix, and attached Gemini logs confirm 33 accepted submissions.
