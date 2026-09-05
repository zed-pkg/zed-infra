import assert from "node:assert/strict";
import { createOriginProxy } from "../shared/origin-proxy.js";

export const statuses = [0, 101, 200, 201, 204, 301, 302, 303, 307, 308,
  400, 401, 403, 404, 426, 500, 502, 503, 504, 521, 522, 523, 524];
export const modes = ["http", "websocket", "reject"];
const worker = createOriginProxy({ label: "app.zpkg.net", unavailableOnNotFoundPaths: ["/"] });

// Sequential, test-only effect injection. Both the full finite matrix and
// generated fmctl trace replay execute the real production fetch handler.
export async function observeOrigin({ mode, status, has_socket, edge_owned }) {
  assert(modes.includes(mode));
  assert(statuses.includes(status));
  assert.equal(typeof has_socket, "boolean");
  assert.equal(typeof edge_owned, "boolean");
  const realFetch = globalThis.fetch;
  let calls = 0;
  let forwarded;
  let originResponse;
  globalThis.fetch = async (request) => {
    calls++;
    forwarded = request;
    if (status === 0) throw new Error("synthetic connection failure");
    // Node's Response cannot represent 101; workerd tests separately prove
    // the actual socket/framing behavior rather than treating this as E2E.
    originResponse = status === 101
      ? { status, webSocket: has_socket ? {} : null, headers: new Headers(), body: null }
      : new Response(null, { status });
    return originResponse;
  };
  try {
    const response = await worker.fetch(new Request(
      `https://app.zpkg.net${edge_owned ? "/" : "/connect"}`,
      { method: mode === "reject" ? "POST" : "GET",
        headers: mode === "http" ? {} : { upgrade: "websocket" } },
    ), {});
    assert(calls <= 1, "a request must not be retried or follow a redirect");
    return {
      outcome: calls === 0 ? "reject" : response.status === 101 ? "upgrade"
        : response.status === 503 ? "unavailable" : "http",
      status_returned: response.status,
      origin_called: calls === 1,
      upgrade_forwarded: forwarded?.headers.get("upgrade") === "websocket"
        && forwarded?.headers.get("connection") === "Upgrade",
      manual_redirect: forwarded?.redirect === "manual",
      socket_passed: response === originResponse && Boolean(response.webSocket),
    };
  } finally {
    globalThis.fetch = realFetch;
  }
}
