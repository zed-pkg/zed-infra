import { HOP_BY_HOP } from "./github-fallback.js";
import { requestMode, responseDecision } from "./origin-transition.js";

/**
 * Orange-cloud origin proxy used by web.zpkg.net, app.zpkg.net, and
 * user.zpkg.net. A proxied DNS record already gives WAF/DDoS; this Worker
 * exists so a dead k8s origin still returns a typed 503 instead of a
 * Cloudflare HTML error page, and so the three hostnames can later diverge
 * (auth gate on user.*, SPA on app.*) without a DNS change.
 */
export function createOriginProxy({
  label,
  retryAfterSeconds = 30,
  unavailableOnNotFoundPaths = [],
}) {
  const edgeOwnedPaths = compileEdgeOwnedPaths(unavailableOnNotFoundPaths);
  const retryAfter = normalizeRetryAfterSeconds(retryAfterSeconds);

  return {
    async fetch(request, env) {
      const mode = requestMode(request.method, request.headers.get("upgrade"));
      if (mode === "reject") {
        return Response.json(
          { ok: false, message: "Unsupported WebSocket upgrade request" },
          { status: 400, headers: { "cache-control": "no-store", "x-zed-edge": label } },
        );
      }
      const headers = new Headers(request.headers);
      for (const name of HOP_BY_HOP) headers.delete(name);
      if (mode === "websocket") {
        // These two hop-by-hop headers are the new upstream handshake, not
        // arbitrary connection metadata. Preserve Origin, cookies, bearer
        // credentials and Sec-WebSocket-* for the origin's own auth policy.
        headers.set("upgrade", "websocket");
        headers.set("connection", "Upgrade");
      }
      const forwarded = new Request(request, { headers, redirect: "manual" });

      let originResponse;
      let handshakeTimer;
      const handshake = mode === "websocket" ? new AbortController() : undefined;
      if (handshake) {
        handshakeTimer = setTimeout(() => handshake.abort(), timeoutMilliseconds(env));
      }
      try {
        // This Worker is attached as a Route, not a Custom Domain. Fetching
        // the original URL reaches the route's underlying DNS origin without
        // reinvoking this Worker, while preserving the public Host that the
        // Kubernetes Ingress uses to select zed-web-server.rs.
        originResponse = await fetch(forwarded, fetchOptions(env, handshake?.signal));
      } catch {
        return unavailable(label, 0, request, retryAfter);
      } finally {
        // AbortSignal.timeout cannot be disarmed and can close an established
        // WebSocket. This deadline bounds setup only; the runtime owns the
        // upgraded connection's lifetime, streaming and backpressure.
        if (handshakeTimer !== undefined) clearTimeout(handshakeTimer);
      }

      const pathname = new URL(request.url).pathname;
      switch (responseDecision(
        mode, originResponse.status, Boolean(originResponse.webSocket), edgeOwnedPaths.has(pathname),
      )) {
        case "upgrade":
          // Return the exact 101 Response. Rebuilding it from body/status
          // drops Cloudflare's socket and breaks the protocol handoff.
          return originResponse;
        case "unavailable":
          await originResponse.body?.cancel().catch(() => {});
          return unavailable(label, originResponse.status, request, retryAfter);
        case "http":
          break;
      }

      const out = new Headers(originResponse.headers);
      out.set("X-Content-Type-Options", "nosniff");
      out.set("X-Zed-Edge", label);
      return new Response(originResponse.body, {
        status: originResponse.status,
        statusText: originResponse.statusText,
        headers: out,
      });
    },
  };
}

function compileEdgeOwnedPaths(paths) {
  if (
    !Array.isArray(paths) ||
    paths.some(
      (path) =>
        typeof path !== "string" ||
        !path.startsWith("/") ||
        path.includes("?") ||
        path.includes("#"),
    )
  ) {
    throw new TypeError("unavailableOnNotFoundPaths must contain absolute URL paths");
  }
  return new Set(paths);
}

function normalizeRetryAfterSeconds(value) {
  if (!Number.isInteger(value) || value < 1 || value > 86400) {
    throw new TypeError("retryAfterSeconds must be an integer from 1 through 86400");
  }
  return value;
}

function timeoutMilliseconds(env) {
  const timeout = Number(env.ORIGIN_TIMEOUT_MS || 8000);
  return Number.isFinite(timeout) && timeout >= 100 && timeout <= 30000 ? timeout : 8000;
}

function fetchOptions(env, handshakeSignal) {
  const options = {
    signal: handshakeSignal ?? AbortSignal.timeout(timeoutMilliseconds(env)),
  };
  // Optional cutover override. Cloudflare permits this only when both the
  // request Host and override are in the same zone, so it cannot become an
  // arbitrary-host proxy. Normal operation follows the Terraform DNS record.
  if (env.ORIGIN_RESOLVE_OVERRIDE) {
    options.cf = { resolveOverride: env.ORIGIN_RESOLVE_OVERRIDE };
  }
  return options;
}

function unavailable(label, originStatus = 0, request, retryAfterSeconds = 30) {
  const retryGuidance = guidanceFor(retryAfterSeconds);
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "retry-after": String(retryAfterSeconds),
    "x-content-type-options": "nosniff",
    "x-robots-tag": "noindex, nofollow",
    "x-zed-edge": label,
  };

  if ((request?.headers.get("accept") || "").includes("text/html")) {
    headers["content-security-policy"] =
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
    headers["content-type"] = "text/html; charset=utf-8";
    return new Response(unavailableHtml(retryGuidance), { status: 503, headers });
  }

  return new Response(
    JSON.stringify({
      ok: false,
      host: label,
      origin_status: originStatus,
      message: `${label} origin is down. ${retryGuidance} GitHub Pages (zpkg.net) and GitHub Releases remain available.`,
    }),
    {
      status: 503,
      headers,
    },
  );
}

function guidanceFor(retryAfterSeconds) {
  if (retryAfterSeconds >= 7200) return "Please come back in about two hours.";
  if (retryAfterSeconds >= 3600) return "Please come back in about an hour.";
  return "Please try again shortly.";
}

function unavailableHtml(retryGuidance) {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Zed app temporarily unavailable</title>
  <style>
    :root { color-scheme: light dark; font-family: ui-sans-serif, system-ui, sans-serif; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #0b1020; color: #eef2ff; }
    main { width: min(38rem, calc(100% - 3rem)); }
    p { color: #cbd5e1; line-height: 1.6; }
    a { color: #93c5fd; }
    code { color: #c4b5fd; }
  </style>
</head>
<body>
  <main>
    <p><code>503 · served by Cloudflare</code></p>
    <h1>The Zed app is temporarily down.</h1>
    <p>Our application servers are not responding. ${retryGuidance}</p>
    <p>The public package site and release artifacts remain online.</p>
    <p><a href="https://zpkg.net/">Return to zpkg.net</a></p>
  </main>
</body>
</html>`;
}
