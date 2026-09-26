/**
 * Public, protocol-preserving native registry gateway.
 *
 * Complex ecosystems cannot be flattened into Zed's `org/name` DTO without
 * losing coordinates, classifiers, platform/build selection, VCS indirection,
 * or OCI semantics. This gateway is deliberately transparent instead: the CLI
 * keeps speaking the ecosystem's real read protocol while Cloudflare provides
 * the emergency transport when Zed services are unavailable.
 *
 * Security model:
 * - GET/HEAD only; publishing credentials never pass through this gateway.
 * - provider is selected from the finite native provider catalog.
 * - every initial URL and redirect must remain on that provider's admitted
 *   metadata/artifact hosts.
 * - Authorization, Cookie, and other caller credentials are never forwarded.
 * - userinfo, plaintext HTTP, explicit ports, fragments, and path traversal are
 *   rejected before the first upstream fetch.
 */

import { USER_AGENT } from "./github-fallback.js";
import { nativeProviderFromToken } from "./native-provider-catalog.js";

const GATEWAY_PATH = /^\/v1\/native\/([a-z0-9-]{1,64})$/;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_REDIRECTS = 4;

export function parseNativeGatewayPath(pathname) {
  if (typeof pathname !== "string" || pathname.includes("%") || pathname.includes("..")) {
    return null;
  }
  const match = pathname.match(GATEWAY_PATH);
  if (!match) {
    return null;
  }
  const provider = nativeProviderFromToken(match[1]);
  if (!provider) {
    return null;
  }
  return { provider };
}

export function allowedNativeGatewayUrl(provider, rawUrl) {
  if (!provider || typeof rawUrl !== "string" || rawUrl.length === 0 || rawUrl.length > 4096) {
    return null;
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.port ||
    url.hash ||
    containsUnsafePath(url.pathname)
  ) {
    return null;
  }

  const admitted = admittedHosts(provider);
  if (!admitted.has(url.hostname.toLowerCase())) {
    return null;
  }
  return url;
}

function containsUnsafePath(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return true;
  }
  return (
    decoded.includes("..") ||
    decoded.includes("\\") ||
    decoded.includes("\0") ||
    /[\r\n]/.test(decoded)
  );
}

function admittedHosts(provider) {
  const hosts = new Set(provider.artifactHosts || []);
  try {
    hosts.add(new URL(provider.metadata).hostname.toLowerCase());
  } catch {
    // Every built-in provider has an absolute metadata URL. A malformed future
    // catalog entry simply becomes less permissive rather than opening access.
  }
  return hosts;
}

export function nativeGatewayRequestHeaders(request) {
  const headers = new Headers();
  headers.set("User-Agent", USER_AGENT);
  headers.set("Accept", request.headers.get("accept") || "*/*");
  for (const name of [
    "if-none-match",
    "if-modified-since",
    "if-match",
    "if-range",
    "range",
  ]) {
    const value = request.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  return headers;
}

export async function handleNativeGateway(request, env) {
  const incoming = new URL(request.url);
  const route = parseNativeGatewayPath(incoming.pathname);
  if (!route) {
    return null;
  }

  const method = request.method.toUpperCase();
  if (method === "OPTIONS") {
    return new Response(null, {
      status: 204,
      headers: {
        allow: "GET, HEAD, OPTIONS",
        "access-control-allow-origin": "*",
        "access-control-allow-methods": "GET, HEAD, OPTIONS",
        "access-control-allow-headers": "accept, range, if-none-match, if-modified-since, if-match, if-range",
      },
    });
  }
  if (method !== "GET" && method !== "HEAD") {
    return gatewayProblem(405, "native_gateway_read_only", "native gateway supports GET and HEAD only", {
      allow: "GET, HEAD, OPTIONS",
    });
  }

  const rawTarget = incoming.searchParams.get("url");
  let current = allowedNativeGatewayUrl(route.provider, rawTarget || "");
  if (!current) {
    return gatewayProblem(400, "invalid_native_upstream", "upstream URL is not admitted for this provider");
  }

  for (let redirects = 0; redirects <= MAX_REDIRECTS; redirects += 1) {
    let response;
    try {
      response = await fetch(current.toString(), {
        method,
        headers: nativeGatewayRequestHeaders(request),
        redirect: "manual",
        signal: AbortSignal.timeout(gatewayTimeout(env)),
      });
    } catch {
      return gatewayProblem(502, "native_upstream_unavailable", "native registry request failed");
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (!location || redirects === MAX_REDIRECTS) {
        return gatewayProblem(502, "native_redirect_rejected", "native registry redirect chain is invalid");
      }
      let redirected;
      try {
        redirected = new URL(location, current);
      } catch {
        return gatewayProblem(502, "native_redirect_rejected", "native registry returned an invalid redirect");
      }
      current = allowedNativeGatewayUrl(route.provider, redirected.toString());
      if (!current) {
        return gatewayProblem(502, "native_redirect_rejected", "native registry redirected outside its admitted hosts");
      }
      continue;
    }

    return gatewayResponse(request, response, route.provider.id, current);
  }

  return gatewayProblem(502, "native_redirect_rejected", "native registry redirect limit exceeded");
}

function gatewayResponse(request, upstream, providerId, finalUrl) {
  const headers = new Headers();
  for (const name of [
    "content-type",
    "content-length",
    "content-encoding",
    "etag",
    "last-modified",
    "accept-ranges",
    "content-range",
    "vary",
    "link",
  ]) {
    const value = upstream.headers.get(name);
    if (value) {
      headers.set(name, value);
    }
  }
  headers.set("x-content-type-options", "nosniff");
  headers.set("x-zed-source", `native-gateway-${providerId}`);
  headers.set("x-zed-native-upstream", finalUrl.hostname);
  headers.set("access-control-allow-origin", "*");
  if (!headers.has("cache-control")) {
    headers.set("cache-control", upstream.ok ? "public, max-age=60" : "no-store");
  }
  return new Response(request.method === "HEAD" ? null : upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

function gatewayTimeout(env) {
  const configured = Number(env?.NATIVE_GATEWAY_TIMEOUT_MS || 8000);
  if (!Number.isFinite(configured)) {
    return 8000;
  }
  return Math.max(500, Math.min(configured, 30000));
}

function gatewayProblem(status, code, message, extraHeaders = {}) {
  return new Response(JSON.stringify({ error: code, message }), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      "x-content-type-options": "nosniff",
      "access-control-allow-origin": "*",
      ...extraHeaders,
    },
  });
}
