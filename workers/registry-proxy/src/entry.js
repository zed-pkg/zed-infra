import registryWorker from "./index.js";
import {
  handleNativeGateway,
  parseNativeGatewayPath,
} from "../../shared/native-gateway.js";

/**
 * Cloudflare entry point for registry.zpkg.net.
 *
 * The implementation in index.js is deliberately runtime-neutral so Node's
 * contract tests can exercise it directly. This boundary adds the one piece
 * of deployment evidence every response must carry: proof that the registry
 * Worker, rather than an origin or a generic Cloudflare error page, produced
 * the response.
 *
 * Native ecosystem wire protocols are intercepted here, before the ordinary
 * Zed registry state machine. They have their own finite provider catalog and
 * read-only state machine, so complex Maven/Go/Conda/OCI coordinates never
 * need to be weakened into the Zed `org/name` route grammar.
 */
export default {
  async fetch(request, env, context) {
    const url = new URL(request.url);
    let response;

    if (parseNativeGatewayPath(url.pathname)) {
      response = await handleNativeGateway(request, env);
    } else {
      response = await registryWorker.fetch(request, env, context);
    }

    const headers = new Headers(response.headers);
    headers.set("x-zed-edge", "registry");

    return new Response(request.method === "HEAD" ? null : response.body, {
      status: response.status,
      statusText: response.statusText,
      headers,
    });
  },
};
