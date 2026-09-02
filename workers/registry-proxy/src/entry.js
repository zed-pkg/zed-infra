import registryWorker from "./index.js";

/**
 * Cloudflare entry point for registry.zpkg.net.
 *
 * The implementation in index.js is deliberately runtime-neutral so Node's
 * contract tests can exercise it directly. This boundary adds the one piece
 * of deployment evidence every response must carry: proof that the registry
 * Worker, rather than an origin or a generic Cloudflare error page, produced
 * the response.
 */
export default {
  async fetch(request, env, context) {
    const response = await registryWorker.fetch(request, env, context);
    const headers = new Headers(response.headers);
    headers.set("x-zed-edge", "registry");

    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
