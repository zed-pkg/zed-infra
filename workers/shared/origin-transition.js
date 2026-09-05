// @ts-check
import { originIsUnavailable } from "./github-fallback.js";

/** @typedef {"http" | "websocket" | "reject"} RequestMode */
/** @typedef {"http" | "upgrade" | "unavailable"} ResponseDecision */

/**
 * Only GET can establish a WebSocket. Unsupported/ambiguous upgrades must
 * not silently turn into ordinary requests. Cloudflare normalizes inbound
 * connection framing, so do not require the client Connection header here.
 * @param {string} method
 * @param {string | null} upgrade
 * @returns {RequestMode}
 */
export function requestMode(method, upgrade) {
  if (upgrade === null) return "http";
  return method === "GET" && upgrade.toLowerCase() === "websocket"
    ? "websocket"
    : "reject";
}

/**
 * A socket is authority supplied by the origin/runtime, never manufactured
 * from the request header alone. All other statuses retain the HTTP policy.
 * @param {RequestMode} mode
 * @param {number} status
 * @param {boolean} hasWebSocket
 * @param {boolean} edgeOwnedNotFound
 * @returns {ResponseDecision}
 */
export function responseDecision(mode, status, hasWebSocket, edgeOwnedNotFound) {
  switch (mode) {
    case "http":
    case "websocket":
      if (status === 101) {
        return mode === "websocket" && hasWebSocket ? "upgrade" : "unavailable";
      }
      return originIsUnavailable(status) || (status === 404 && edgeOwnedNotFound)
        ? "unavailable"
        : "http";
    case "reject":
      throw new TypeError("Rejected requests must not reach an origin");
    default: {
      /** @type {never} */
      const exhaustive = mode;
      throw new TypeError(`Unknown request mode: ${exhaustive}`);
    }
  }
}
