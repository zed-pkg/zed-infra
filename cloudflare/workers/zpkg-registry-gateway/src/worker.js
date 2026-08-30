// zpkg-registry-gateway — registry.zpkg.net, which is a *sub-path* of the API
// server rather than a second copy of it.
//
// api.zpkg.net is the whole API: the registry surface plus the account plane
// (sessions, org dashboards, the Supabase token exchange) that the web UI
// needs. registry.zpkg.net is the hostname compiled into every `zed` binary
// (zed-interfaces/src/rust/registry.rs), and the only thing a package manager
// ever needs from it is packages, artifacts, search, orgs' signing keys, and
// the mirror set. Serving the account plane there too would mean every CLI in
// the world could reach the session endpoints on the hostname it is configured
// to trust most — for no gain, since no CLI calls them.
//
// So this Worker is an allowlist, not a proxy with a deny list. A route that is
// not named here does not exist on this hostname. That direction matters: the
// account plane is nested at BOTH `/api/v1` and `/v1` in the API server
// (src/account_router.rs:74-75), so "everything under /v1" would have quietly
// re-exposed exactly what this is meant to withhold.
//
// The origin is reached by its own hostname (api.zpkg.net, or a per-cloud
// origin during a cutover) so that this Worker keeps working while the public
// api record is being repointed.

/**
 * The registry surface, as declared in zed-api-server.rs src/routes/mod.rs.
 * Each entry is matched against the full pathname: a string matches exactly or
 * as a path prefix followed by `/`; a RegExp must match the whole path.
 */
const ALLOWED = [
  "/healthz",
  "/.well-known/zpkg-mirrors.json",
  "/v1/packages",            // list, package, version, yank, signed-index, graphs, embedding
  "/v1/search",              // and /v1/search/semantic
  "/v1/orgs",                // claim, keys, audit — publish needs all three
  "/v1/mirrors",
  "/v1/artifacts",           // /v1/artifacts/{sha256}
  "/v1/files",               // unpkg-style file reads
  "/v1/storage",             // read-only backend status and reconciliation
  /^\/v1\/resolutions\/[A-Za-z0-9._-]+\/dependency-graph(\/[A-Za-z0-9._-]+)?$/,
];

/**
 * Paths that live under an allowed prefix but belong to the account plane.
 * Checked first, so a future `/v1/orgs/...` account route cannot leak in by
 * being nested under a prefix this file already trusts.
 */
const DENIED = ["/v1/account", "/v1/auth", "/v1/me", "/v1/session", "/api", "/docs", "/openapi.json"];

const SECURITY_HEADERS = {
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, POST, PUT, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, if-none-match, range",
};

function matches(pathname, rule) {
  if (rule instanceof RegExp) return rule.test(pathname);
  return pathname === rule || pathname.startsWith(rule + "/");
}

function problem(status, code, detail) {
  return new Response(JSON.stringify({ error: code, detail }), {
    status,
    headers: { "content-type": "application/problem+json", ...SECURITY_HEADERS },
  });
}

export default {
  /**
   * @param {Request} request
   * @param {{ ORIGIN_URL: string, CDN_URL?: string }} env
   */
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }

    if (DENIED.some((d) => matches(url.pathname, d))) {
      // 404, not 403: the account plane is not a thing you are forbidden from
      // on this hostname, it is a thing that is not here. Say so without
      // confirming what exists on the other one.
      return problem(404, "not_found", "registry.zpkg.net serves the registry API only; the account API is on api.zpkg.net");
    }
    if (!ALLOWED.some((a) => matches(url.pathname, a))) {
      return problem(404, "not_found", `no registry route at ${url.pathname}`);
    }

    const origin = new URL(env.ORIGIN_URL);
    const upstream = new URL(url.pathname + url.search, origin);

    // Preserve the method, body, and Authorization header: publish is a POST
    // with a bearer token and an artifact-sized body, and it has to work
    // through here or `zed publish` against the default registry is broken.
    const forwarded = new Request(upstream, request);
    forwarded.headers.set("host", origin.host);
    forwarded.headers.set("x-forwarded-host", url.host);
    forwarded.headers.set("x-forwarded-proto", "https");

    let response;
    try {
      response = await fetch(forwarded, { redirect: "manual" });
    } catch (err) {
      // The registry being down is exactly the case the CDN mirror exists for,
      // so say where to go rather than returning a bare 502.
      return new Response(
        JSON.stringify({
          error: "origin_unreachable",
          detail: "the registry origin did not answer",
          mirrors: env.CDN_URL ? `${env.CDN_URL}/.well-known/zpkg-mirrors.json` : undefined,
        }),
        { status: 502, headers: { "content-type": "application/problem+json", ...SECURITY_HEADERS } },
      );
    }

    const headers = new Headers(response.headers);
    for (const [k, v] of Object.entries(SECURITY_HEADERS)) headers.set(k, v);

    // An artifact download answers 302 to a presigned URL. Rewriting it to the
    // public CDN when one is configured takes the presign — and its 600-second
    // clock — out of the path for bytes that are already content-addressed.
    const location = response.headers.get("location");
    if (env.CDN_URL && response.status === 302 && location) {
      const sha = url.pathname.match(/^\/v1\/artifacts\/([0-9a-f]{64})$/);
      if (sha) headers.set("location", `${env.CDN_URL}/artifacts/${sha[1]}.tar.gz`);
    }

    return new Response(response.body, { status: response.status, headers });
  },
};
