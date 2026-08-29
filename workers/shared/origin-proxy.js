import { HOP_BY_HOP, originIsUnavailable } from "./github-fallback.js";

/**
 * Orange-cloud origin proxy used by web.zpkg.net, app.zpkg.net, and
 * user.zpkg.net. A proxied DNS record already gives WAF/DDoS; this Worker
 * exists so a dead k8s origin still returns a typed 503 instead of a
 * Cloudflare HTML error page, and so the three hostnames can later diverge
 * (auth gate on user.*, SPA on app.*) without a DNS change.
 */
export function createOriginProxy({ label }) {
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
        return unavailable(label);
      }

      if (originIsUnavailable(originResponse.status)) {
        return unavailable(label, originResponse.status);
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

function unavailable(label, originStatus = 0) {
  return new Response(
    JSON.stringify({
      ok: false,
      host: label,
      origin_status: originStatus,
      message: `${label} origin is down; GitHub Pages (zpkg.net) and GitHub Releases remain available`,
    }),
    {
      status: 503,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "x-content-type-options": "nosniff",
        "retry-after": "30",
        "x-zed-edge": label,
      },
    },
  );
}
