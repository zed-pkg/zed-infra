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
      const originUrl = env.ORIGIN_URL;
      if (!originUrl) {
        return new Response(`${label} origin is not configured\n`, {
          status: 500,
          headers: { "content-type": "text/plain; charset=utf-8" },
        });
      }

      const incoming = new URL(request.url);
      const target = new URL(incoming.pathname + incoming.search, originUrl);
      const headers = new Headers(request.headers);
      for (const name of HOP_BY_HOP) headers.delete(name);
      headers.set("Host", new URL(originUrl).host);

      const upgrade = request.headers.get("Upgrade");
      if (upgrade && upgrade.toLowerCase() === "websocket") {
        return fetch(new Request(target, request));
      }

      let originResponse;
      try {
        originResponse = await fetch(
          new Request(target.toString(), {
            method: request.method,
            headers,
            body: request.body,
            redirect: "manual",
          }),
          { signal: AbortSignal.timeout(Number(env.ORIGIN_TIMEOUT_MS || 8000)) },
        );
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
