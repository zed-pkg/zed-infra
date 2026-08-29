import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  classifyRegistryRequest,
  REGISTRY_ACTION,
} from "./shared/github-fallback.js";

const openapiPath = process.argv[2];
if (!openapiPath) {
  throw new Error("usage: node workers/check-api-contract.mjs <zed.openapi.json>");
}

const document = JSON.parse(readFileSync(openapiPath, "utf8"));
const operations = [];
for (const [template, item] of Object.entries(document.paths || {})) {
  for (const method of ["get", "head", "post", "put", "patch", "delete"]) {
    if (item[method]) operations.push([method.toUpperCase(), template]);
  }
}

assert.ok(operations.length > 0, "machine-registry OpenAPI has no operations");
for (const [method, template] of operations) {
  const path = examplePath(template);
  const decision = classifyRegistryRequest(method, path);
  assert.notEqual(
    decision.action,
    REGISTRY_ACTION.DENY_ROUTE,
    `edge rejects current API route ${method} ${template} (example ${path})`,
  );
  assert.notEqual(
    decision.action,
    REGISTRY_ACTION.DENY_METHOD,
    `edge rejects current API method ${method} ${template}`,
  );
}

// These paths are implemented by the same process but intentionally excluded
// from the machine OpenAPI and registry hostname.
for (const path of [
  "/api/v1/auth/config",
  "/api/v1/account/me",
  "/v1/account/me",
  "/v1/me",
  "/v1/session/bootstrap",
]) {
  assert.equal(
    classifyRegistryRequest("GET", path).action,
    REGISTRY_ACTION.DENY_ROUTE,
    `edge widened to account path ${path}`,
  );
}

process.stdout.write(`edge accepts all ${operations.length} current machine-registry operations\n`);

function examplePath(template) {
  return template
    .replaceAll("{org}", "acme")
    .replaceAll("{name}", "http-kit")
    .replaceAll("{version}", "1.0.0")
    .replaceAll("{sha256}", "a".repeat(64))
    .replaceAll("{path}", "README.md")
    .replaceAll("{resolution_digest}", `sha256:${"b".repeat(64)}`)
    .replaceAll("{format}", "json");
}
