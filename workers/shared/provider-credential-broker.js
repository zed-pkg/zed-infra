// @ts-check

/**
 * Provider-scoped credential broker client for authenticated edge fallback.
 *
 * The edge may ask for a short-lived upstream credential only after Zed has
 * authorized an exact package/provider/resource tuple. This module never
 * accepts browser Authorization headers, SSH private keys, PATs, npm tokens,
 * or other caller-supplied provider credentials.
 */

export const BROKER_CONTRACT_VERSION = 1;
export const BROKER_MAX_TTL_SECONDS = 300;
export const BROKER_MAX_RESPONSE_BYTES = 16 * 1024;

const BROKER_URL = "https://credential-broker.internal/v1/credentials";
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,255}$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/;
const RESPONSE_KEYS = new Set([
  "version",
  "provider",
  "kind",
  "resource",
  "credential_ref",
  "access_token",
  "issued_at",
  "expires_at",
  "permissions",
]);

/**
 * Request a provider credential from an internal service binding.
 *
 * @param {{
 *   fetch(input: Request|string, init?: RequestInit): Promise<Response>
 * }} broker
 * @param {{
 *   provider: "github",
 *   operation: "read",
 *   package: string,
 *   resource: string,
 *   credentialRef: string,
 * }} plan
 * @param {{
 *   principal: string,
 *   sessionLineage: string,
 *   capabilityId: string,
 *   capabilityExpiresAt: number,
 *   requestedTtlSeconds?: number,
 *   nowEpochSeconds?: number,
 * }} context
 * @returns {Promise<GitHubBrokerCredential>}
 */
export async function requestProviderCredential(broker, plan, context) {
  if (!broker || typeof broker.fetch !== "function") {
    throw new TypeError("credential broker service binding is required");
  }
  validatePlan(plan);
  validateContext(context);

  const now = context.nowEpochSeconds ?? Math.floor(Date.now() / 1000);
  const remaining = context.capabilityExpiresAt - now;
  if (!Number.isSafeInteger(remaining) || remaining <= 0) {
    throw new CredentialBrokerError("capability_expired", "capability is already expired");
  }

  const requested = context.requestedTtlSeconds ?? BROKER_MAX_TTL_SECONDS;
  if (!Number.isSafeInteger(requested) || requested < 1 || requested > BROKER_MAX_TTL_SECONDS) {
    throw new CredentialBrokerError(
      "invalid_ttl",
      `credential TTL must be between 1 and ${BROKER_MAX_TTL_SECONDS} seconds`,
    );
  }
  const ttl = Math.min(requested, remaining, BROKER_MAX_TTL_SECONDS);
  if (ttl < 1) {
    throw new CredentialBrokerError("capability_expired", "capability has no remaining lifetime");
  }

  const body = {
    version: BROKER_CONTRACT_VERSION,
    provider: plan.provider,
    operation: "read",
    package: plan.package,
    resource: plan.resource,
    credential_ref: plan.credentialRef,
    principal: context.principal,
    session_lineage: context.sessionLineage,
    capability_id: context.capabilityId,
    requested_ttl_seconds: ttl,
  };

  const response = await broker.fetch(
    new Request(BROKER_URL, {
      method: "POST",
      headers: {
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify(body),
      redirect: "error",
    }),
  );

  if (!response.ok) {
    throw new CredentialBrokerError(
      "broker_rejected",
      `credential broker rejected request with status ${response.status}`,
    );
  }
  if (!hasNoStore(response.headers.get("cache-control"))) {
    throw new CredentialBrokerError(
      "unsafe_cache_policy",
      "credential broker response must be cache-control: no-store",
    );
  }

  const contentType = response.headers.get("content-type") || "";
  if (!/^application\/(?:[a-z0-9.+-]*\+)?json(?:\s*;|$)/i.test(contentType)) {
    throw new CredentialBrokerError("invalid_response", "credential broker must return JSON");
  }

  const declared = Number(response.headers.get("content-length") || 0);
  if (declared > BROKER_MAX_RESPONSE_BYTES) {
    throw new CredentialBrokerError("response_too_large", "credential broker response is too large");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength > BROKER_MAX_RESPONSE_BYTES) {
    throw new CredentialBrokerError("response_too_large", "credential broker response is too large");
  }

  let raw;
  try {
    raw = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    throw new CredentialBrokerError("invalid_response", "credential broker returned invalid JSON");
  }

  return validateGithubCredential(raw, plan, now, ttl);
}

/**
 * Convert a validated broker result to upstream GitHub headers.
 *
 * @param {GitHubBrokerCredential} credential
 * @returns {Readonly<Record<string,string>>}
 */
export function githubCredentialHeaders(credential) {
  if (!credential || credential.provider !== "github" || credential.kind !== "github-app-installation") {
    throw new CredentialBrokerError("invalid_credential", "validated GitHub App credential is required");
  }
  return Object.freeze({
    accept: "application/vnd.github+json",
    authorization: `Bearer ${credential.accessToken}`,
    "x-github-api-version": "2022-11-28",
  });
}

function validatePlan(plan) {
  if (!plan || plan.provider !== "github") {
    throw new CredentialBrokerError("unsupported_provider", "only github broker semantics are enabled");
  }
  if (plan.operation !== "read") {
    throw new CredentialBrokerError("write_forbidden", "credential broker is read-only");
  }
  if (typeof plan.package !== "string" || plan.package.length < 3 || plan.package.length > 257) {
    throw new CredentialBrokerError("invalid_package", "package coordinate is invalid");
  }
  if (typeof plan.resource !== "string" || !GITHUB_REPOSITORY.test(plan.resource)) {
    throw new CredentialBrokerError("invalid_resource", "GitHub resource must be one owner/repo");
  }
  if (typeof plan.credentialRef !== "string" || !CREDENTIAL_REF.test(plan.credentialRef)) {
    throw new CredentialBrokerError("invalid_credential_ref", "credential reference is invalid");
  }
}

function validateContext(context) {
  if (!context || typeof context !== "object") {
    throw new CredentialBrokerError("invalid_context", "broker context is required");
  }
  for (const [name, value] of [
    ["principal", context.principal],
    ["session lineage", context.sessionLineage],
    ["capability id", context.capabilityId],
  ]) {
    if (typeof value !== "string" || !IDENTIFIER.test(value)) {
      throw new CredentialBrokerError("invalid_context", `${name} is invalid`);
    }
  }
  if (!Number.isSafeInteger(context.capabilityExpiresAt) || context.capabilityExpiresAt < 0) {
    throw new CredentialBrokerError("invalid_context", "capability expiry is invalid");
  }
}

function validateGithubCredential(raw, plan, now, requestedTtl) {
  if (!isRecord(raw)) {
    throw new CredentialBrokerError("invalid_response", "broker response must be an object");
  }
  rejectUnknownKeys(raw, RESPONSE_KEYS);
  if (
    raw.version !== BROKER_CONTRACT_VERSION ||
    raw.provider !== "github" ||
    raw.kind !== "github-app-installation"
  ) {
    throw new CredentialBrokerError("invalid_response", "broker returned the wrong credential type");
  }
  if (raw.resource !== plan.resource || raw.credential_ref !== plan.credentialRef) {
    throw new CredentialBrokerError("scope_mismatch", "broker widened or changed credential scope");
  }
  if (
    typeof raw.access_token !== "string" ||
    raw.access_token.length < 16 ||
    raw.access_token.length > 4096 ||
    /[\r\n]/.test(raw.access_token)
  ) {
    throw new CredentialBrokerError("invalid_response", "broker access token is invalid");
  }
  if (!Number.isSafeInteger(raw.issued_at) || !Number.isSafeInteger(raw.expires_at)) {
    throw new CredentialBrokerError("invalid_response", "broker credential timestamps are invalid");
  }
  if (raw.issued_at > now + 30 || raw.expires_at <= now) {
    throw new CredentialBrokerError("invalid_response", "broker credential is not currently valid");
  }
  if (raw.expires_at - now > requestedTtl + 30) {
    throw new CredentialBrokerError("ttl_widened", "broker credential exceeds requested lifetime");
  }

  const permissions = raw.permissions;
  if (!isRecord(permissions)) {
    throw new CredentialBrokerError("invalid_permissions", "GitHub App permissions are required");
  }
  const allowed = new Set(["contents", "metadata"]);
  for (const [key, value] of Object.entries(permissions)) {
    if (!allowed.has(key) || value !== "read") {
      throw new CredentialBrokerError(
        "invalid_permissions",
        "GitHub App credential may grant only read contents/metadata",
      );
    }
  }
  if (permissions.contents !== "read") {
    throw new CredentialBrokerError("invalid_permissions", "GitHub contents:read is required");
  }

  return Object.freeze({
    version: BROKER_CONTRACT_VERSION,
    provider: "github",
    kind: "github-app-installation",
    resource: raw.resource,
    credentialRef: raw.credential_ref,
    accessToken: raw.access_token,
    issuedAt: raw.issued_at,
    expiresAt: raw.expires_at,
    permissions: Object.freeze({ ...permissions }),
    cachePolicy: "private-no-store",
  });
}

function hasNoStore(value) {
  return typeof value === "string" &&
    value.split(",").some((part) => part.trim().toLowerCase() === "no-store");
}

function rejectUnknownKeys(value, allowed) {
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new CredentialBrokerError("unknown_field", `unsupported broker response field: ${key}`);
    }
  }
}

function isRecord(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

export class CredentialBrokerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "CredentialBrokerError";
    this.code = code;
  }
}

/**
 * @typedef {{
 *   version: 1,
 *   provider: "github",
 *   kind: "github-app-installation",
 *   resource: string,
 *   credentialRef: string,
 *   accessToken: string,
 *   issuedAt: number,
 *   expiresAt: number,
 *   permissions: Readonly<Record<string,"read">>,
 *   cachePolicy: "private-no-store",
 * }} GitHubBrokerCredential
 */
