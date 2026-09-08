import { createOriginProxy } from "../../shared/origin-proxy.js";

// api.zpkg.net is the full stateful API. Authentication, authorization, and
// every write remain origin-owned; the edge only replaces transport/52x
// failures with a deterministic, cache-disabled response that clients can
// distinguish from Cloudflare's generic HTML error page.
export default createOriginProxy({ label: "api.zpkg.net" });
