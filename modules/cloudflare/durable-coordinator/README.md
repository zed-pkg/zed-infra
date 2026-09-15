# zed-pkg Durable Object coordinator

`ZedPackageCoordinator` is the edge serialization primitive for package publish/idempotency and registry coordination.

- Cloudflare Builds root: `modules/cloudflare/durable-coordinator`
- Terraform owns the stable per-environment Worker shell.
- Wrangler owns versions, bindings, and declarative Durable Object `exports`.
- Storage is SQLite-backed.
- `workers.dev` is disabled everywhere; preview URLs are enabled only for `preview`.
- No production route is declared here; routing is a separate reviewed exposure change.

Bindings are repeated under every Wrangler environment because Durable Object bindings are non-inheritable. Top-level `exports` is inherited and each environment gets its own namespace.

Validation: `npm install && npm run check`.

Deploy with `npm run deploy:preview`, `npm run deploy:staging`, or `npm run deploy:production`.

The coordinator exposes `GET /health`, and versioned `GET`/`PUT`/`DELETE /state/<key>`. `PUT` accepts optional `If-Match: "<version>"` for optimistic concurrency. The top-level Worker selects the Durable Object instance from `?object=<aggregate-name>`.
