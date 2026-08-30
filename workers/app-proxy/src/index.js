import { createOriginProxy } from "../../shared/origin-proxy.js";

export default createOriginProxy({
  label: "app.zpkg.net",
  unavailableOnNotFoundPaths: ["/login", "/signup"],
});
