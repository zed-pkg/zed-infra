import { HOP_BY_HOP, originIsUnavailable } from "./github-fallback.js";

/**
 * Orange-cloud origin proxy used by web.zpkg.net, app.zpkg.net, and
 * user.zpkg.net. A proxied DNS record already gives WAF/DDoS; this Worker
 * exists so a dead k8s origin still returns a typed 503 instead of a
 * Cloudflare HTML error page, and so the three hostnames can later diverge
 * (auth gate on user.*, SPA on app.*) without a DNS change.
 */
export function createOriginProxy({ label, unavailableOnNotFoundPaths = [] }) {
  const edgeOwnedPaths = compileEdgeOwnedPaths(unavailableOnNotFoundPaths);

  return {
    async fetch(request, env) {
      const headers = new Headers(request.headers);
      for (const name of HOP_BY_HOP) headers.delete(name);
      const forwarded = new Request(request, { headers, redirect: "manual" });

      const upgrade = request.headers.get("Upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        return fetch(forwarded, fetchOptions(env));
      }

      let originResponse;
      try {
        // This Worker is attached as a Route, not a Custom Domain. Fetching
        // the original URL reaches the route's underlying DNS origin without
        // reinvoking this Worker, while preserving the public Host that the
        // Kubernetes Ingress uses to select zed-web-server.rs.
        originResponse = await fetch(forwarded, fetchOptions(env));
      } catch {
        return unavailable(label, 0, request);
      }

      const pathname = new URL(request.url).pathname;
      if (
        originIsUnavailable(originResponse.status) ||
        (originResponse.status === 404 && edgeOwnedPaths.has(pathname))
      ) {
        return unavailable(label, originResponse.status, request);
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

function fetchOptions(env) {
  const timeout = Number(env.ORIGIN_TIMEOUT_MS || 8000);
  const options = {
    signal: AbortSignal.timeout(
      Number.isFinite(timeout) && timeout >= 100 && timeout <= 30000 ? timeout : 8000,
    ),
  };
  // Optional cutover override. Cloudflare permits this only when both the
  // request Host and override are in the same zone, so it cannot become an
  // arbitrary-host proxy. Normal operation follows the Terraform DNS record.
  if (env.ORIGIN_RESOLVE_OVERRIDE) {
    options.cf = { resolveOverride: env.ORIGIN_RESOLVE_OVERRIDE };
  }
  return options;
}

function unavailable(label, originStatus = 0, request) {
  const headers = {
    "cache-control": "no-store",
    "content-type": "application/json; charset=utf-8",
    "referrer-policy": "no-referrer",
    "retry-after": "30",
    "x-content-type-options": "nosniff",
    "x-zed-edge": label,
  };

  if ((request?.headers.get("accept") || "").includes("text/html")) {
    headers["content-security-policy"] =
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; frame-ancestors 'none'";
    headers["content-type"] = "text/html; charset=utf-8";
    return new Response(unavailableHtml(), { status: 503, headers });
  }

  return new Response(
    JSON.stringify({
      ok: false,
      host: label,
      origin_status: originStatus,
      message: `${label} origin is down; GitHub Pages (zpkg.net) and GitHub Releases remain available`,
    }),
    {
      status: 503,
      headers,
    },
  );
}

function unavailableHtml() {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Zed account portal temporarily unavailable</title>
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
    <h1>The Zed account portal is temporarily unavailable.</h1>
    <p>The application origin is not ready, but the public package site and release artifacts remain online. Please retry in a moment.</p>
    <p><a href="https://zpkg.net/">Return to zpkg.net</a></p>
  </main>
</body>
</html>`;
}
