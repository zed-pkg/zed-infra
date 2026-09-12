# zpkg public-intake Worker

This path-specific Cloudflare Worker serves and submits the two public commercial-intake pages:

- `https://user.zpkg.net/pre-interest`
- `https://org.zpkg.net/quote`

Cloudflare route patterns end in `*` so query strings match; the Worker independently admits only the exact path or its trailing-slash form and rejects every overmatch. The existing `user.zpkg.net/*` web proxy remains the less-specific fallback.

POST requests require exact same-origin form context when form encoded, a valid Turnstile proof bound to the expected hostname and action, strict closed-field validation, bounded bodies, and the merged `zed.public-intake.v1` contract. The Worker canonicalizes the request and signs its body digest, host, API path, timestamp, and idempotency key before forwarding to `api.zpkg.net`. It stores no submission data.

Required production bindings:

- `TURNSTILE_SITE_KEY` — public widget key, supplied as a GitHub Environment variable;
- `TURNSTILE_SECRET_KEY` — Worker secret;
- `INTAKE_SIGNING_KEY` — at least 32 bytes, shared only with the Rust API;
- `CONSENT_REVISION` and `MARKETING_CONSENT_REVISION` — reviewed portable identifiers;
- `API_ORIGIN` — HTTPS origin, normally `https://api.zpkg.net`.

A successful response is deliberately generic and cannot reveal whether an address or request ID already existed. No live route is claimed until the protected deployment workflow and outside-in canary succeed.
