# Public-intake Worker instructions

These instructions refine the repository-root `agents.md` for `workers/public-intake`.

- Apply `https://github.com/ORESoftware/my-ai/blob/main/AGENTS.md` together with every readable ancestor `agents.md`.
- Keep routing and validation as total, side-effect-free functions; keep Turnstile verification and API forwarding at the outer effect boundary.
- The Worker derives `sourceHost` and intent from the exact standard host/path pair. Never trust caller-supplied forwarding, host, party, or administrative fields.
- Public responses, logs, metrics, URLs, idempotency keys, and error details must not contain submitted contact data or requirements text.
- Production POST handling fails closed unless Turnstile, signing, consent-revision, and API-origin bindings are present.
- Do not store quote or registration payloads at the edge. The Rust API and reviewed product persistence layer own writes.
- Prove overmatched wildcard-route rejection because Cloudflare route patterns are broader than the two admitted page paths.
