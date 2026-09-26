// @ts-check

/**
 * Authenticated edge fallback capability verification and provider request planning.
 *
 * This module is intentionally side-effect free except for WebCrypto verification.
 * It never fetches issuer keys, provider credentials, or package bytes. Workers
 * receive a pinned/cached JWKS snapshot and a capability, then derive a narrow
 * provider request plan. Provider credentials stay behind a separate broker.
 */

export const EDGE_CAPABILITY_VERSION = 1;
export const EDGE_CAPABILITY_AUDIENCE = "zed-edge-fallback";
export const EDGE_CAPABILITY_MAX_TTL_SECONDS = 300;
export const EDGE_CAPABILITY_CLOCK_SKEW_SECONDS = 30;

const MAX_TOKEN_BYTES = 24 * 1024;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_GRANTS = 16;
const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const GITHUB_REPOSITORY = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const NPM_SCOPED_PACKAGE = /^@[a-z0-9][a-z0-9._-]*\/[a-z0-9][a-z0-9._-]*$/;
const CARGO_CRATE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const CREDENTIAL_REF = /^[A-Za-z0-9][A-Za-z0-9:._/-]{0,191}$/;
const JTI = /^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/;

const CLAIM_KEYS = new Set([
  "zed_edge_capability",
  "iss",
  "aud",
  "sub",
  "iat",
  "nbf",
  "exp",
  "jti",
  "grants",
]);

const GRANT_KEYS = new Set([
  "provider",
  "operation",
  "package",
  "resource",
  "origin",
  "credential_ref",
]);

const PROVIDERS = new Set(["github", "npm", "cargo-registry"]);

/**
 * Verify a compact RS256 JWT and validate the v1 edge capability claims.
 *
 * JWKS is supplied by deployment/runtime configuration. This function never
 * performs network I/O, so an already-issued capability remains verifiable
 * while zed-api-server and Shared Auth are unavailable.
 *
 * @param {string} token
 * @param {{
 *   issuer: string,
 *   jwks: string | {keys: JsonWebKey[]},
 *   audience?: string,
 *   nowEpochSeconds?: number,
 *   maxTtlSeconds?: number,
 *   clockSkewSeconds?: number,
 * }} options
 * @returns {Promise<EdgeCapabilityClaims>}
 */
export async function verifyEdgeCapability(token, options) {
  if (typeof token !== "string" || token.length === 0 || token.length > MAX_TOKEN_BYTES) {
    throw new EdgeCapabilityError("invalid_token", "capability must be a bounded compact JWT");
  }
  if (!options || typeof options.issuer !== "string" || options.issuer.length === 0) {
    throw new TypeError("issuer is required");
  }

  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new EdgeCapabilityError("invalid_token", "capability must have three JWT segments");
  }

  const header = decodeJsonSegment(parts[0], "header");
  const claims = decodeJsonSegment(parts[1], "claims");
  if (!isRecord(header) || header.alg !== "RS256" || header.typ !== "JWT") {
    throw new EdgeCapabilityError("unsupported_algorithm", "only typ=JWT alg=RS256 is accepted");
  }
  if (typeof header.kid !== "string" || !JTI.test(header.kid)) {
    throw new EdgeCapabilityError("invalid_kid", "JWT kid is missing or invalid");
  }

  const jwks = parseJwks(options.jwks);
  const jwk = jwks.keys.find(
    (candidate) =>
      candidate &&
      candidate.kid === header.kid &&
      candidate.kty === "RSA" &&
      (!candidate.alg || candidate.alg === "RS256") &&
      (!candidate.use || candidate.use === "sig"),
  );
  if (!jwk) {
    throw new EdgeCapabilityError("unknown_kid", "no pinned verification key matches the JWT kid");
  }

  let key;
  try {
    key = await crypto.subtle.importKey(
      "jwk",
      jwk,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["verify"],
    );
  } catch {
    throw new EdgeCapabilityError("invalid_jwk", "verification key cannot be imported");
  }

  const signature = decodeBase64Url(parts[2], "signature");
  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    signature,
    new TextEncoder().encode(`${parts[0]}.${parts[1]}`),
  );
  if (!valid) {
    throw new EdgeCapabilityError("invalid_signature", "capability signature verification failed");
  }

  return validateClaims(claims, {
    issuer: options.issuer,
    audience: options.audience ?? EDGE_CAPABILITY_AUDIENCE,
    nowEpochSeconds: options.nowEpochSeconds ?? Math.floor(Date.now() / 1000),
    maxTtlSeconds: options.maxTtlSeconds ?? EDGE_CAPABILITY_MAX_TTL_SECONDS,
    clockSkewSeconds: options.clockSkewSeconds ?? EDGE_CAPABILITY_CLOCK_SKEW_SECONDS,
  });
}

/**
 * Convert a verified capability into a secret-free provider request plan.
 *
 * The caller must resolve credentialRef through a provider-specific broker.
 * Never replace credentialRef with a user bearer token or SSH private key.
 *
 * @param {EdgeCapabilityClaims} claims
 * @param {{
 *   provider: "github" | "npm" | "cargo-registry",
 *   operation?: "read",
 *   package: string,
 *   resource: string,
 *   url: string,
 * }} request
 * @returns {ProviderRequestPlan}
 */
export function planProviderRequest(claims, request) {
  if (!claims || claims.zed_edge_capability !== EDGE_CAPABILITY_VERSION) {
    throw new EdgeCapabilityError("unverified_capability", "a verified v1 capability is required");
  }
  const operation = request?.operation ?? "read";
  if (operation !== "read") {
    throw new EdgeCapabilityError("write_forbidden", "edge fallback capabilities are read-only");
  }

  const grant = claims.grants.find(
    (candidate) =>
      candidate.provider === request?.provider &&
      candidate.operation === operation &&
      candidate.package === request?.package &&
      candidate.resource === request?.resource,
  );
  if (!grant) {
    throw new EdgeCapabilityError(
      "grant_mismatch",
      "capability does not authorize this provider/package/resource tuple",
    );
  }

  let url;
  try {
    url = new URL(request.url);
  } catch {
    throw new EdgeCapabilityError("invalid_provider_url", "provider URL is invalid");
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new EdgeCapabilityError(
      "invalid_provider_url",
      "provider requests require credential-free HTTPS URLs",
    );
  }

  assertProviderDestination(grant, url);

  return Object.freeze({
    provider: grant.provider,
    operation: "read",
    package: grant.package,
    resource: grant.resource,
    url: url.toString(),
    credentialRef: grant.credential_ref,
    cachePolicy: "private-no-store",
    forwardUserAuthorization: false,
  });
}

/**
 * @param {unknown} rawClaims
 * @param {{issuer:string,audience:string,nowEpochSeconds:number,maxTtlSeconds:number,clockSkewSeconds:number}} policy
 * @returns {EdgeCapabilityClaims}
 */
function validateClaims(rawClaims, policy) {
  if (!isRecord(rawClaims)) {
    throw new EdgeCapabilityError("invalid_claims", "capability claims must be an object");
  }
  rejectUnknownKeys(rawClaims, CLAIM_KEYS, "claims");

  if (rawClaims.zed_edge_capability !== EDGE_CAPABILITY_VERSION) {
    throw new EdgeCapabilityError("invalid_version", "unsupported edge capability version");
  }
  if (rawClaims.iss !== policy.issuer) {
    throw new EdgeCapabilityError("invalid_issuer", "capability issuer does not match");
  }
  if (rawClaims.aud !== policy.audience) {
    throw new EdgeCapabilityError("invalid_audience", "capability audience does not match");
  }
  if (
    typeof rawClaims.sub !== "string" ||
    rawClaims.sub.length < 1 ||
    rawClaims.sub.length > 256 ||
    /[\u0000-\u001f]/.test(rawClaims.sub)
  ) {
    throw new EdgeCapabilityError("invalid_subject", "capability subject is invalid");
  }
  if (typeof rawClaims.jti !== "string" || !JTI.test(rawClaims.jti)) {
    throw new EdgeCapabilityError("invalid_jti", "capability jti is missing or invalid");
  }

  const iat = integerClaim(rawClaims.iat, "iat");
  const exp = integerClaim(rawClaims.exp, "exp");
  const nbf = rawClaims.nbf === undefined ? iat : integerClaim(rawClaims.nbf, "nbf");
  if (exp <= iat || exp - iat > policy.maxTtlSeconds) {
    throw new EdgeCapabilityError(
      "invalid_lifetime",
      "capability lifetime must be positive and within the configured maximum",
    );
  }
  if (iat > policy.nowEpochSeconds + policy.clockSkewSeconds) {
    throw new EdgeCapabilityError("not_yet_valid", "capability was issued in the future");
  }
  if (nbf > policy.nowEpochSeconds + policy.clockSkewSeconds) {
    throw new EdgeCapabilityError("not_yet_valid", "capability is not active yet");
  }
  if (exp <= policy.nowEpochSeconds - policy.clockSkewSeconds) {
    throw new EdgeCapabilityError("expired", "capability has expired");
  }

  if (!Array.isArray(rawClaims.grants) || rawClaims.grants.length < 1 || rawClaims.grants.length > MAX_GRANTS) {
    throw new EdgeCapabilityError("invalid_grants", "capability must contain 1..16 grants");
  }
  const grants = rawClaims.grants.map(validateGrant);

  return Object.freeze({
    zed_edge_capability: EDGE_CAPABILITY_VERSION,
    iss: rawClaims.iss,
    aud: rawClaims.aud,
    sub: rawClaims.sub,
    iat,
    nbf,
    exp,
    jti: rawClaims.jti,
    grants: Object.freeze(grants),
  });
}

/**
 * @param {unknown} rawGrant
 * @returns {EdgeCapabilityGrant}
 */
function validateGrant(rawGrant) {
  if (!isRecord(rawGrant)) {
    throw new EdgeCapabilityError("invalid_grant", "grant must be an object");
  }
  rejectUnknownKeys(rawGrant, GRANT_KEYS, "grant");

  if (typeof rawGrant.provider !== "string" || !PROVIDERS.has(rawGrant.provider)) {
    throw new EdgeCapabilityError("invalid_provider", "grant provider is unsupported");
  }
  if (rawGrant.operation !== "read") {
    throw new EdgeCapabilityError("invalid_operation", "edge fallback grants are read-only");
  }
  if (!isPackageCoordinate(rawGrant.package)) {
    throw new EdgeCapabilityError("invalid_package", "grant package must be a canonical org/name coordinate");
  }
  if (typeof rawGrant.credential_ref !== "string" || !CREDENTIAL_REF.test(rawGrant.credential_ref)) {
    throw new EdgeCapabilityError("invalid_credential_ref", "grant credential_ref is invalid");
  }

  const origin = validateProviderResource(
    /** @type {"github" | "npm" | "cargo-registry"} */ (rawGrant.provider),
    rawGrant.resource,
    rawGrant.origin,
  );

  return Object.freeze({
    provider: /** @type {"github" | "npm" | "cargo-registry"} */ (rawGrant.provider),
    operation: "read",
    package: rawGrant.package,
    resource: /** @type {string} */ (rawGrant.resource),
    ...(origin ? { origin } : {}),
    credential_ref: rawGrant.credential_ref,
  });
}

function validateProviderResource(provider, resource, origin) {
  if (typeof resource !== "string" || resource.length === 0 || resource.length > 256) {
    throw new EdgeCapabilityError("invalid_resource", "grant resource is invalid");
  }
  switch (provider) {
    case "github":
      if (!GITHUB_REPOSITORY.test(resource)) {
        throw new EdgeCapabilityError("invalid_resource", "GitHub resource must be owner/repo");
      }
      if (origin !== undefined) {
        throw new EdgeCapabilityError("invalid_origin", "GitHub grants use fixed provider origins");
      }
      return null;
    case "npm":
      if (!NPM_SCOPED_PACKAGE.test(resource)) {
        throw new EdgeCapabilityError("invalid_resource", "private npm resource must be @scope/name");
      }
      if (origin !== undefined) {
        throw new EdgeCapabilityError("invalid_origin", "npm grants use the fixed npm registry origin");
      }
      return null;
    case "cargo-registry": {
      if (!CARGO_CRATE.test(resource)) {
        throw new EdgeCapabilityError("invalid_resource", "Cargo resource must be a crate name");
      }
      if (typeof origin !== "string") {
        throw new EdgeCapabilityError("invalid_origin", "private Cargo grants require an exact registry origin");
      }
      let parsed;
      try {
        parsed = new URL(origin);
      } catch {
        throw new EdgeCapabilityError("invalid_origin", "private Cargo registry origin is invalid");
      }
      if (
        parsed.protocol !== "https:" ||
        parsed.username ||
        parsed.password ||
        parsed.pathname !== "/" ||
        parsed.search ||
        parsed.hash
      ) {
        throw new EdgeCapabilityError(
          "invalid_origin",
          "private Cargo registry origin must be a credential-free HTTPS origin",
        );
      }
      return parsed.origin;
    }
    default:
      throw new EdgeCapabilityError("invalid_provider", "grant provider is unsupported");
  }
}

/**
 * @param {EdgeCapabilityGrant} grant
 * @param {URL} url
 */
function assertProviderDestination(grant, url) {
  switch (grant.provider) {
    case "github": {
      const [owner, repo] = grant.resource.split("/");
      const prefix = `/${owner}/${repo}`;
      const apiPrefix = `/repos${prefix}`;
      const allowed =
        (url.hostname === "api.github.com" && pathIsWithin(url.pathname, apiPrefix)) ||
        (url.hostname === "github.com" && pathIsWithin(url.pathname, prefix)) ||
        (url.hostname === "raw.githubusercontent.com" && pathIsWithin(url.pathname, prefix));
      if (!allowed) {
        throw new EdgeCapabilityError(
          "provider_destination_mismatch",
          "GitHub URL is outside the authorized repository",
        );
      }
      return;
    }
    case "npm": {
      if (url.hostname !== "registry.npmjs.org") {
        throw new EdgeCapabilityError(
          "provider_destination_mismatch",
          "npm fallback is restricted to registry.npmjs.org",
        );
      }
      let decoded;
      try {
        decoded = decodeURIComponent(url.pathname);
      } catch {
        throw new EdgeCapabilityError("invalid_provider_url", "npm URL path is malformed");
      }
      const prefix = `/${grant.resource}`;
      if (!pathIsWithin(decoded, prefix)) {
        throw new EdgeCapabilityError(
          "provider_destination_mismatch",
          "npm URL is outside the authorized package",
        );
      }
      return;
    }
    case "cargo-registry":
      if (!grant.origin || url.origin !== grant.origin) {
        throw new EdgeCapabilityError(
          "provider_destination_mismatch",
          "Cargo URL is outside the authorized private registry origin",
        );
      }
      return;
    default:
      throw new EdgeCapabilityError("invalid_provider", "grant provider is unsupported");
  }
}

function pathIsWithin(pathname, prefix) {
  const normalizedPath = pathname.replace(/\/+$/, "");
  const normalizedPrefix = prefix.replace(/\/+$/, "");
  return normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`);
}

function parseJwks(value) {
  let parsed = value;
  if (typeof value === "string") {
    if (value.length === 0 || value.length > 128 * 1024) {
      throw new EdgeCapabilityError("invalid_jwks", "JWKS snapshot is missing or too large");
    }
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new EdgeCapabilityError("invalid_jwks", "JWKS snapshot is not valid JSON");
    }
  }
  if (!isRecord(parsed) || !Array.isArray(parsed.keys) || parsed.keys.length < 1 || parsed.keys.length > 32) {
    throw new EdgeCapabilityError("invalid_jwks", "JWKS snapshot must contain 1..32 keys");
  }
  return /** @type {{keys: JsonWebKey[]}} */ (parsed);
}

function decodeJsonSegment(segment, name) {
  const bytes = decodeBase64Url(segment, name);
  if (bytes.byteLength > MAX_JSON_BYTES) {
    throw new EdgeCapabilityError("invalid_token", `${name} exceeds size limit`);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new EdgeCapabilityError("invalid_token", `${name} is not UTF-8`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new EdgeCapabilityError("invalid_token", `${name} is not valid JSON`);
  }
}

function decodeBase64Url(value, name) {
  if (typeof value !== "string" || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new EdgeCapabilityError("invalid_token", `${name} is not base64url`);
  }
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  let binary;
  try {
    binary = atob(value.replace(/-/g, "+").replace(/_/g, "/") + padding);
  } catch {
    throw new EdgeCapabilityError("invalid_token", `${name} is not valid base64url`);
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) {
    bytes[index] = binary.charCodeAt(index);
  }
  return bytes;
}


function integerClaim(value, name) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new EdgeCapabilityError("invalid_time_claim", `${name} must be a non-negative integer`);
  }
  return value;
}

function isPackageCoordinate(value) {
  if (typeof value !== "string" || value.length > 257) return false;
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => part.length <= 128 && SLUG.test(part));
}

function rejectUnknownKeys(object, allowed, label) {
  for (const key of Object.keys(object)) {
    if (!allowed.has(key)) {
      throw new EdgeCapabilityError("unknown_field", `${label} contains unsupported field ${key}`);
    }
  }
}

function isRecord(value) {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export class EdgeCapabilityError extends Error {
  constructor(code, message) {
    super(message);
    this.name = "EdgeCapabilityError";
    this.code = code;
  }
}

/**
 * @typedef {{
 *   provider: "github" | "npm" | "cargo-registry",
 *   operation: "read",
 *   package: string,
 *   resource: string,
 *   origin?: string,
 *   credential_ref: string,
 * }} EdgeCapabilityGrant
 */

/**
 * @typedef {{
 *   zed_edge_capability: 1,
 *   iss: string,
 *   aud: string,
 *   sub: string,
 *   iat: number,
 *   nbf: number,
 *   exp: number,
 *   jti: string,
 *   grants: readonly EdgeCapabilityGrant[],
 * }} EdgeCapabilityClaims
 */

/**
 * @typedef {{
 *   provider: "github" | "npm" | "cargo-registry",
 *   operation: "read",
 *   package: string,
 *   resource: string,
 *   url: string,
 *   credentialRef: string,
 *   cachePolicy: "private-no-store",
 *   forwardUserAuthorization: false,
 * }} ProviderRequestPlan
 */
