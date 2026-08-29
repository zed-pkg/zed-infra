import {
  githubApiRepoUrl,
  githubFallbackUrlsForCdn,
  githubHeaders,
  githubIdentity,
  originIsUnavailable,
  parseCdnPath,
  USER_AGENT,
} from "../../shared/github-fallback.js";
import {
  isAllowedNativeDownloadUrl,
  nativeHeaders,
  nativeTarballUrls,
  publicNativeHostFromOrg,
} from "../../shared/native-public.js";

const ARTIFACT_KEY = /^artifacts\/[0-9a-f]{64}\.(tar\.gz|zip)$/;
const METADATA_KEY =
  /^metadata\/[a-z0-9][a-z0-9-]*\/[a-z0-9][a-z0-9-]*\/(index\.json|versions\/[A-Za-z0-9][A-Za-z0-9.+-]{0,127}\.json)$/;
const WELL_KNOWN_MIRRORS = "/.well-known/zpkg-mirrors.json";
const IMMUTABLE = "public, max-age=31536000, immutable";
const METADATA_CACHE = "public, max-age=60, stale-while-revalidate=600";
const NO_STORE = "no-store";
const MAX_PUBLIC_ARTIFACT_BYTES = 110 * 1024 * 1024;
const MAX_GITHUB_JSON_BYTES = 1024 * 1024;

const SECURITY_HEADERS = Object.freeze({
  "x-content-type-options": "nosniff",
  "content-security-policy": "default-src 'none'; sandbox",
  "referrer-policy": "no-referrer",
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, HEAD, OPTIONS",
  "access-control-allow-headers": "range, if-none-match",
  "access-control-expose-headers": "content-length, content-range, etag",
});

export default {
  async fetch(request, env) {
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: SECURITY_HEADERS });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return problem(405, "method_not_allowed", "this mirror is read-only", {
        allow: "GET, HEAD, OPTIONS",
      });
    }

    const url = new URL(request.url);
    if (url.pathname === "/" || url.pathname === "/healthz") {
      return json(200, { ok: true, service: "zpkg-cdn" }, NO_STORE, request.method);
    }
    if (url.pathname === WELL_KNOWN_MIRRORS) {
      return bootstrap(env, request.method);
    }

    const directKey = canonicalCdnKey(url.pathname);
    const parsed =
      parseCdnPath(url.pathname) ||
      (directKey && METADATA_KEY.test(directKey)
        ? { kind: "cdn_metadata", key: directKey }
        : null);
    if (!parsed) return problem(404, "not_found", "no such public object");

    // Only content-addressed artifacts and signed metadata can read R2. The
    // bucket is private and may eventually contain private coordinate aliases;
    // `/packages/*` and `/github/*` therefore require independent public proof
    // and never become a general R2 read oracle.
    if (ARTIFACT_KEY.test(parsed.key) || METADATA_KEY.test(parsed.key)) {
      const object = await getR2(env, parsed.key, request);
      if (object) return object;
    }

    const native = await getNativePublic(parsed, request, env);
    if (native) return native;

    const github = await getGithubPublic(parsed, request, env);
    if (github) return github;

    return problem(404, "not_found", "no independently public artifact source was found");
  },
};

async function getR2(env, key, request) {
  if (!env.ARTIFACTS) return null;
  let object;
  try {
    object = await env.ARTIFACTS.get(key, {
      range: request.headers,
      onlyIf: request.headers,
    });
  } catch {
    return null;
  }
  if (!object) return null;

  const headers = securityHeaders();
  if (typeof object.writeHttpMetadata === "function") object.writeHttpMetadata(headers);
  if (object.httpEtag) headers.set("etag", object.httpEtag);
  headers.set("accept-ranges", "bytes");
  headers.set("x-zed-edge", "cdn");
  headers.set("x-zed-source", "r2");
  headers.set("x-zpkg-mirror", "zpkg-cdn");
  const metadata = METADATA_KEY.test(key);
  headers.set("cache-control", metadata ? METADATA_CACHE : IMMUTABLE);
  headers.set(
    "content-type",
    metadata ? "application/json" : key.endsWith(".zip") ? "application/zip" : "application/gzip",
  );

  if (request.method === "HEAD" || !("body" in object) || object.body === null) {
    if ("size" in object) headers.set("content-length", String(object.size));
    return new Response(null, { status: request.method === "HEAD" ? 200 : 304, headers });
  }
  if (object.range && "offset" in object.range && "length" in object.range) {
    const start = object.range.offset;
    const end = start + object.range.length - 1;
    headers.set("content-range", `bytes ${start}-${end}/${object.size}`);
    return new Response(object.body, { status: 206, headers });
  }
  return new Response(object.body, { status: 200, headers });
}

async function getNativePublic(parsed, request, env) {
  if (parsed.kind !== "cdn_package_object") return null;
  const host = publicNativeHostFromOrg(parsed.org);
  if (!host) return null;
  for (const url of nativeTarballUrls(host, parsed.name, parsed.version, parsed.filename)) {
    const response = await fetchWithValidatedRedirects(
      url,
      request.method,
      nativeHeaders("application/octet-stream"),
      (candidate) => isAllowedNativeDownloadUrl(host, candidate, parsed.name, parsed.version),
      timeout(env),
    );
    const sanitized = sanitizePublicArtifact(response, request.method, `native-${host.id}`);
    if (sanitized) return sanitized;
  }
  return null;
}

async function getGithubPublic(parsed, request, env) {
  let identity;
  if (parsed.kind === "cdn_github_object") {
    identity = { owner: parsed.owner, repo: parsed.repo };
  } else if (parsed.kind === "cdn_package_object") {
    if (publicNativeHostFromOrg(parsed.org)) return null;
    identity = githubIdentity(parsed.org, parsed.name);
  } else {
    return null;
  }
  if (!(await isPublicGithubRepo(identity, env))) return null;

  for (const url of githubFallbackUrlsForCdn(parsed)) {
    const response = await fetchWithValidatedRedirects(
      url,
      request.method,
      { Accept: "application/octet-stream", "User-Agent": USER_AGENT },
      isAllowedGithubArtifactUrl,
      timeout(env),
    );
    const sanitized = sanitizePublicArtifact(response, request.method, "github-release");
    if (sanitized) return sanitized;
  }
  return null;
}

async function isPublicGithubRepo(identity, env) {
  let response;
  try {
    response = await fetch(githubApiRepoUrl(identity), {
      headers: githubHeaders(),
      redirect: "error",
      signal: AbortSignal.timeout(timeout(env)),
    });
  } catch {
    return false;
  }
  if (!response.ok) return false;
  const body = await readBoundedJson(response, MAX_GITHUB_JSON_BYTES);
  return Boolean(
    body &&
      body.private === false &&
      body.visibility === "public" &&
      body.owner?.login?.toLowerCase() === identity.owner.toLowerCase() &&
      body.name?.toLowerCase() === identity.repo.toLowerCase(),
  );
}

async function fetchWithValidatedRedirects(url, method, headers, allowUrl, timeoutMs) {
  let current = url;
  for (let redirects = 0; redirects <= 3; redirects += 1) {
    if (!allowUrl(current)) return null;
    let response;
    try {
      response = await fetch(current, {
        method,
        headers,
        redirect: "manual",
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch {
      return null;
    }
    if ([301, 302, 303, 307, 308].includes(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === 3) return null;
      current = new URL(location, current).toString();
      continue;
    }
    return response;
  }
  return null;
}

function isAllowedGithubArtifactUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      !url.username &&
      !url.password &&
      !url.port &&
      ["github.com", "objects.githubusercontent.com", "release-assets.githubusercontent.com"].includes(
        url.hostname,
      ) &&
      (url.hostname !== "github.com" || url.pathname.includes("/releases/download/"))
    );
  } catch {
    return false;
  }
}

function sanitizePublicArtifact(response, method, source) {
  if (!response || !response.ok || originIsUnavailable(response.status)) return null;
  const declared = Number(response.headers.get("content-length") || 0);
  // A bounded length is mandatory for a streaming public proxy. Without it a
  // hostile upstream could turn the Worker into an unbounded transfer.
  if (!Number.isSafeInteger(declared) || declared <= 0 || declared > MAX_PUBLIC_ARTIFACT_BYTES) {
    return null;
  }
  const headers = securityHeaders();
  for (const name of ["content-length", "content-type", "etag", "last-modified", "accept-ranges"]) {
    const value = response.headers.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("cache-control", IMMUTABLE);
  headers.set("x-zed-edge", "cdn");
  headers.set("x-zed-source", source);
  headers.set("x-zpkg-mirror", source);
  return new Response(method === "HEAD" ? null : response.body, {
    status: response.status === 206 ? 206 : 200,
    headers,
  });
}

async function readBoundedJson(response, maxBytes) {
  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) return null;
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > maxBytes) return null;
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > maxBytes) return null;
  try {
    return JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return null;
  }
}

function bootstrap(env, method) {
  let mirrors = [];
  if (env.MIRRORS) {
    try {
      mirrors = JSON.parse(env.MIRRORS);
    } catch {
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
    method,
  );
}

function json(status, body, cacheControl, method = "GET") {
  const headers = securityHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", cacheControl);
  const serialized = JSON.stringify(body) + "\n";
  if (method === "HEAD") headers.set("content-length", String(new TextEncoder().encode(serialized).length));
  return new Response(method === "HEAD" ? null : serialized, { status, headers });
}

function problem(status, code, message, extra = {}) {
  const headers = securityHeaders();
  headers.set("content-type", "application/json; charset=utf-8");
  headers.set("cache-control", NO_STORE);
  for (const [name, value] of Object.entries(extra)) headers.set(name, value);
  return new Response(JSON.stringify({ code, message }) + "\n", { status, headers });
}

function securityHeaders() {
  return new Headers(SECURITY_HEADERS);
}

function canonicalCdnKey(pathname) {
  if (typeof pathname !== "string" || pathname.length > 513 || !pathname.startsWith("/")) {
    return null;
  }
  if (pathname.includes("%") || pathname.includes("\\") || pathname.includes("\0")) return null;
  const key = pathname.slice(1).replace(/\/+$/, "");
  if (!key || key.includes("..") || key.includes("//")) return null;
  return key;
}

function timeout(env) {
  const value = Number(env?.FALLBACK_TIMEOUT_MS || 5000);
  return Number.isFinite(value) && value >= 100 && value <= 30000 ? value : 5000;
}

export const _internals = {
  ARTIFACT_KEY,
  METADATA_KEY,
  canonicalCdnKey,
  isAllowedGithubArtifactUrl,
  sanitizePublicArtifact,
};
