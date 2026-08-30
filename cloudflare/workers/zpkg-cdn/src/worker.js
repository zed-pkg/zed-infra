// zpkg-cdn — public, read-only, content-addressed access to the artifact
// bucket.
//
// This exists so an outage of the registry API is not an outage of `zed
// install`. A lockfile pins an artifact's sha256, and the bucket keys artifacts
// by that same digest, so a client that already has a lock can fetch bytes here
// with no API call, no presigned URL, and no credential — and verify them
// itself. The Worker cannot lie about what it serves: the key *is* the hash of
// the correct answer.
//
// Two hostnames, on purpose. `cdn.zpkg.net` is the friendly one. The
// `workers.dev` hostname is the one that matters: it resolves through a zone
// zed does not own and cannot misconfigure, so it survives losing `zpkg.net`
// entirely — an expired registration, a bad DNS change, a zone suspension. A
// fallback that shares a failure domain with the thing it backs up is not a
// fallback.
//
// Deliberately not here: writes (there is no PUT — a mirror that accepts
// writes is a second source of truth), listing (the bucket's key space is not
// public information, and enumeration is how you inventory a supply chain),
// and any route that takes a key from the caller unvalidated.

/** Only two shapes of key are reachable, both of them content-addressed. */
const ARTIFACT_KEY = /^artifacts\/[0-9a-f]{64}\.(tar\.gz|zip)$/;
/** Publisher-signed metadata: coordinate-addressed, so it is shape-checked. */
const METADATA_KEY =
  /^metadata\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/(index\.json|versions\/[A-Za-z0-9][A-Za-z0-9.+-]{0,127}\.json)$/;

const WELL_KNOWN_MIRRORS = "/.well-known/zpkg-mirrors.json";

/** Artifacts are immutable by construction: the name is the hash. */
const IMMUTABLE = "public, max-age=31536000, immutable";
/**
 * Metadata is mutable, but staleness is bounded by the signature's own
 * sequence check on the client, so a short edge cache is safe and takes the
 * thundering herd off the origin during the outage this is built for.
 */
const METADATA_CACHE = "public, max-age=60, stale-while-revalidate=600";

const SECURITY_HEADERS = {
  // A bucket that serves user-uploaded archives must never let a browser
  // decide one is HTML.
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "referrer-policy": "no-referrer",
  // Any origin may fetch: these are public artifacts, and a browser-based
  // client is one of the consumers this path exists for.
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "range, if-none-match",
  "access-control-expose-headers": "content-length, content-range, etag",
};

export default {
  /**
   * @param {Request} request
   * @param {{ ARTIFACTS: R2Bucket, MIRRORS?: string, REGISTRY_URL?: string }} env
   */
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      // 405 with Allow, not 404: a client that tried to PUT should learn the
      // route exists and is read-only, rather than that it is missing.
      return problem(405, "method_not_allowed", "this mirror is read-only", {
        allow: "GET, HEAD, OPTIONS",
      });
    }

    const url = new URL(request.url);

    if (url.pathname === "/" || url.pathname === "/healthz") {
      return json(200, { ok: true, service: "zpkg-cdn" }, IMMUTABLE_NONE);
    }
    if (url.pathname === WELL_KNOWN_MIRRORS) {
      return bootstrap(env);
    }

    const key = decodeKey(url.pathname);
    if (key === null) {
      return problem(400, "invalid_key", "not a valid mirror key");
    }

    const kind = ARTIFACT_KEY.test(key)
      ? "artifact"
      : METADATA_KEY.test(key)
        ? "metadata"
        : null;
    if (kind === null) {
      // Shape-check before touching R2. An unconstrained key would turn this
      // into a general-purpose read oracle over the bucket, and the bucket
      // holds more than the public artifact space.
      return problem(404, "not_found", "no such object");
    }

    const object = await env.ARTIFACTS.get(key, {
      range: request.headers,
      onlyIf: request.headers,
    });
    if (object === null) {
      return problem(404, "not_found", "no such object");
    }

    const headers = new Headers(SECURITY_HEADERS);
    object.writeHttpMetadata(headers);
    headers.set("etag", object.httpEtag);
    headers.set(
      "cache-control",
      kind === "artifact" ? IMMUTABLE : METADATA_CACHE,
    );
    headers.set("accept-ranges", "bytes");
    headers.set(
      "content-type",
      kind === "metadata"
        ? "application/json"
        : key.endsWith(".zip")
          ? "application/zip"
          : "application/gzip",
    );
    // Names the transport in the answer, so a `zed install` that fell back can
    // say where the bytes actually came from.
    headers.set("x-zpkg-mirror", "zpkg-cdn");

    // `body` absent means R2 satisfied a conditional or the caller sent HEAD.
    if (!("body" in object) || object.body === null) {
      const status = request.method === "HEAD" ? 200 : 304;
      if (status === 200 && "size" in object) {
        headers.set("content-length", String(object.size));
      }
      return new Response(null, { status, headers });
    }

    if (object.range && "offset" in object.range && "length" in object.range) {
      const start = object.range.offset;
      const end = start + object.range.length - 1;
      headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
      return new Response(object.body, { status: 206, headers });
    }
    return new Response(object.body, { status: 200, headers });
  },
};

const IMMUTABLE_NONE = "no-store";

/**
 * The bootstrap document. Static configuration rather than a bucket read: it
 * has to answer even if R2 is the thing that is broken, since a client asking
 * for it is already in trouble.
 */
function bootstrap(env) {
  let mirrors = [];
  if (env.MIRRORS) {
    try {
      mirrors = JSON.parse(env.MIRRORS);
    } catch {
      // A malformed binding must not take the route down; an empty mirror
      // list still tells a client the registry URL, which is more than a 500
      // would.
      mirrors = [];
    }
  }
  return json(
    200,
    {
      schema: "zpkg.mirror-bootstrap/v1",
      generated_at: new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      registry_url: env.REGISTRY_URL || "https://registry.zpkg.net",
      mirrors,
    },
    METADATA_CACHE,
  );
}

/**
 * Percent-decode a path into a bucket key, refusing anything that could escape
 * the key space. Decoding happens exactly once: a key that still contains `%`
 * after one pass is rejected rather than decoded again, because a second pass
 * is how `%252e%252e` becomes `..`.
 */
export function decodeKey(pathname) {
  if (!pathname.startsWith("/")) return null;
  const raw = pathname.slice(1);
  if (raw.length === 0 || raw.length > 512) return null;
  let decoded;
  try {
    decoded = decodeURIComponent(raw);
  } catch {
    return null;
  }
  if (decoded.includes("%")) return null;
  if (
    decoded.includes("..") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    decoded.startsWith("/") ||
    decoded.includes("//")
  ) {
    return null;
  }
  return decoded;
}

function json(status, body, cacheControl) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("content-type", "application/json");
  headers.set("cache-control", cacheControl);
  return new Response(JSON.stringify(body, null, 2) + "\n", { status, headers });
}

function problem(status, code, message, extra = {}) {
  const headers = new Headers(SECURITY_HEADERS);
  headers.set("content-type", "application/json");
  headers.set("cache-control", "no-store");
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(JSON.stringify({ code, message }) + "\n", {
    status,
    headers,
  });
}

export const _internals = { ARTIFACT_KEY, METADATA_KEY, decodeKey };
