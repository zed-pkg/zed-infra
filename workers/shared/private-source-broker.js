const MAX_RESPONSE_BYTES = 32 * 1024;
const ALLOWED_PROVIDERS = new Set(["github", "npm", "cargo-registry"]);
const MAX_TTL_SECONDS = 300;

function boundedString(value, label, max = 512) {
  if (typeof value !== "string" || value.length === 0 || value.length > max) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function validateResource(provider, resource) {
  if (!resource || Array.isArray(resource) || typeof resource !== "object") {
    throw new Error("invalid resource");
  }
  if (provider === "github") {
    return Object.freeze({
      owner: boundedString(resource.owner, "resource.owner"),
      repo: boundedString(resource.repo, "resource.repo"),
    });
  }
  if (provider === "npm") {
    return Object.freeze({
      scope: boundedString(resource.scope, "resource.scope"),
      package: boundedString(resource.package, "resource.package"),
    });
  }
  if (provider === "cargo-registry") {
    return Object.freeze({
      registry: boundedString(resource.registry, "resource.registry"),
      package: boundedString(resource.package, "resource.package"),
    });
  }
  throw new Error("unsupported provider");
}

export function brokerRequestFromCapability(capability, provider, resource) {
  if (!capability || typeof capability !== "object") throw new Error("invalid capability");
  if (!ALLOWED_PROVIDERS.has(provider)) throw new Error("unsupported provider");
  if (capability.source?.provider !== provider) throw new Error("provider mismatch");

  const checkedResource = validateResource(provider, resource);
  if (provider === "github") {
    if (
      capability.source.owner !== checkedResource.owner ||
      capability.source.repo !== checkedResource.repo
    ) {
      throw new Error("resource mismatch");
    }
  } else if (provider === "npm") {
    if (
      capability.source.scope !== checkedResource.scope ||
      capability.source.package !== checkedResource.package
    ) {
      throw new Error("resource mismatch");
    }
  } else if (
    capability.source.registry !== checkedResource.registry ||
    capability.source.package !== checkedResource.package
  ) {
    throw new Error("resource mismatch");
  }

  return Object.freeze({
    schema: "zed.private-source-credential-request.v1",
    provider,
    resource: checkedResource,
    principal: boundedString(capability.subject, "principal"),
    sessionId: boundedString(capability.proof?.sessionId, "sessionId"),
    capabilityId: boundedString(capability.jti, "capabilityId"),
    authEpoch: capability.proof?.authEpoch,
    policyEpoch: capability.proof?.policyEpoch,
    expiresAt: capability.exp,
  });
}

export async function requestProviderCredential(binding, request, options = {}) {
  if (!binding || typeof binding.fetch !== "function") {
    throw new Error("credential broker unavailable");
  }
  const now = Number.isSafeInteger(options.now)
    ? options.now
    : Math.floor(Date.now() / 1000);
  const body = JSON.stringify(request);
  let response;
  try {
    response = await binding.fetch("https://credential-broker.internal/v1/credential", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
      },
      body,
    });
  } catch {
    throw new Error("credential broker unavailable");
  }

  if (!response.ok) throw new Error("credential broker denied request");
  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > MAX_RESPONSE_BYTES) throw new Error("credential broker response too large");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > MAX_RESPONSE_BYTES) throw new Error("credential broker response too large");

  let value;
  try {
    value = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new Error("credential broker response malformed");
  }
  const credential = validateCredential(value, request, now);
  return Object.freeze(credential);
}

function validateCredential(value, request, now) {
  if (!value || Array.isArray(value) || typeof value !== "object") {
    throw new Error("credential broker response malformed");
  }
  if (value.schema !== "zed.private-source-credential.v1") {
    throw new Error("credential broker schema mismatch");
  }
  if (value.provider !== request.provider) throw new Error("credential provider mismatch");

  const token = boundedString(value.token, "credential token", 8192);
  const expiresAt = value.expiresAt;
  if (!Number.isSafeInteger(expiresAt) || expiresAt <= now || expiresAt > now + MAX_TTL_SECONDS) {
    throw new Error("credential expiry outside policy");
  }
  const resource = validateResource(value.provider, value.resource);
  if (JSON.stringify(resource) !== JSON.stringify(request.resource)) {
    throw new Error("credential resource mismatch");
  }

  if (value.provider === "github" && value.kind !== "github-app-installation") {
    throw new Error("unexpected GitHub credential kind");
  }
  if (value.provider === "npm" && value.kind !== "npm-read-token") {
    throw new Error("unexpected npm credential kind");
  }
  if (value.provider === "cargo-registry" && value.kind !== "cargo-registry-read-token") {
    throw new Error("unexpected Cargo credential kind");
  }

  return {
    provider: value.provider,
    kind: value.kind,
    token,
    expiresAt,
    resource,
  };
}

export function upstreamAuthorizationHeaders(credential) {
  if (!credential || !ALLOWED_PROVIDERS.has(credential.provider)) return null;
  const headers = new Headers({
    "cache-control": "private, no-store",
    pragma: "no-cache",
  });
  headers.set("authorization", `Bearer ${credential.token}`);
  return headers;
}
