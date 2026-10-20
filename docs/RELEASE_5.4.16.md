# K.I.T.T. Reverse Proxy 5.4.16

Enforce model identity only for the authenticated Agent Contract v5 call path. The Agent CLI must use the actual `/v1/models` model ID or bind the intended Reverse-Proxy instance to that role. On a mismatch the proxy returns HTTP 409 `agent_model_mismatch`, without initiating WebChat submission. Previous 5.4.15 session generation fix remains intact. Validate with HTTP integration tests, the full npm verify suite, and the ecosystem pin matrix.
