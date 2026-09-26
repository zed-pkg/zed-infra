const textDecoder = new TextDecoder();

const SUPPORTED_ALGORITHMS = Object.freeze({
  RS256: {
    importAlgorithm: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    verifyAlgorithm: { name: "RSASSA-PKCS1-v1_5" },
  },
  ES256: {
    importAlgorithm: { name: "ECDSA", namedCurve: "P-256" },
    verifyAlgorithm: { name: "ECDSA", hash: "SHA-256" },
  },
});

const SOURCE_PROVIDERS = new Set(["github", "npm", "cargo-registry"]);
const CAPABILITY = "fallback:read";

function decodeBase64Url(value) {
  if (typeof value !== "string" || value.length === 0 || !/^[A-Za-z0-9_-]+$/.test(value)) {
    throw new Error("invalid base64url");
  }
  const padded = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  if (typeof atob === "function") {
    const decoded = atob(padded);
    return Uint8Array.from(decoded, (char) => char.charCodeAt(0));
  }
  return Uint8Array.from(Buffer.from(padded, "base64"));
}

function decodeJson(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(textDecoder.decode(decodeBase64Url(value)));
  } catch {
    throw new Error(`invalid ${label}`);
  }
  if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
    throw new Error(`invalid ${label}`);
  }
  return parsed;
}

function parseCompactJwt(token) {
  if (typeof token !== "string" || token.length > 16384) {
    throw new Error("invalid token");
  }
  const parts = token.split(".");
  if (parts.length !== 3 || parts.some((part) => part.length === 0)) {
    throw new Error("invalid token");
  }
  const [encodedHeader, encodedPayload, encodedSignature] = parts;
  return {
    encodedHeader,
    encodedPayload,
    signature: decodeBase64Url(encodedSignature),
    header: decodeJson(encodedHeader, "header"),
    claims: decodeJson(encodedPayload, "claims"),
  };
}

function stringClaim(value, label) {
  if (typeof value !== "string" || value.length === 0 || value.length > 512) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function stringArray(value, label) {
  if (!Array.isArray(value) || value.length === 0 || value.length > 32) {
    throw new Error(`invalid ${label}`);
  }
  const normalized = value.map((entry) => stringClaim(entry, label));
  if (new Set(normalized).size !== normalized.length) {
    throw new Error(`invalid ${label}`);
  }
  return normalized;
}

function audienceMatches(aud, expected) {
  if (typeof aud === "string") return aud === expected;
  return Array.isArray(aud) && aud.length > 0 && aud.every((value) => typeof value === "string") && aud.includes(expected);
}

function integerDate(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`invalid ${label}`);
  }
  return value;
}

function normalizeProof(proof, policy, now, skew) {
  if (!proof || Array.isArray(proof) || typeof proof !== "object") {
    throw new Error("invalid proof");
  }
  if (proof.reconciliation !== "reconciled") {
    throw new Error("proof is not reconciled");
  }
  const revocationCheckedAt = integerDate(
    proof.revocationCheckedAt,
    "proof.revocationCheckedAt",
  );
  if (revocationCheckedAt > now + skew) {
    throw new Error("revocation check is in future");
  }
  const maxRevocationAgeSeconds = Number.isSafeInteger(policy.maxRevocationAgeSeconds)
    ? policy.maxRevocationAgeSeconds
    : 120;
  if (maxRevocationAgeSeconds < 0 || maxRevocationAgeSeconds > 900) {
    throw new Error("invalid max revocation age");
  }
  if (now - revocationCheckedAt > maxRevocationAgeSeconds) {
    throw new Error("revocation state is stale");
  }
  return Object.freeze({
    sessionId: stringClaim(proof.sessionId, "proof.sessionId"),
    authEpoch: integerDate(proof.authEpoch, "proof.authEpoch"),
    policyEpoch: integerDate(proof.policyEpoch, "proof.policyEpoch"),
    reconciliation: "reconciled",
    revocationCheckedAt,
  });
}

function normalizeSource(source) {
  if (!source || Array.isArray(source) || typeof source !== "object") {
    throw new Error("invalid source");
  }
  const provider = stringClaim(source.provider, "source.provider");
  if (!SOURCE_PROVIDERS.has(provider)) throw new Error("invalid source.provider");

  if (provider === "github") {
    return Object.freeze({
      provider,
      owner: stringClaim(source.owner, "source.owner"),
      repo: stringClaim(source.repo, "source.repo"),
    });
  }
  if (provider === "npm") {
    return Object.freeze({
      provider,
      scope: stringClaim(source.scope, "source.scope"),
      package: stringClaim(source.package, "source.package"),
    });
  }
  return Object.freeze({
    provider,
    registry: stringClaim(source.registry, "source.registry"),
    package: stringClaim(source.package, "source.package"),
  });
}

function normalizePackage(pkg) {
  if (!pkg || Array.isArray(pkg) || typeof pkg !== "object") {
    throw new Error("invalid package");
  }
  return Object.freeze({
    org: stringClaim(pkg.org, "package.org"),
    name: stringClaim(pkg.name, "package.name"),
  });
}

function normalizeArtifact(artifact) {
  if (artifact === undefined || artifact === null) return null;
  if (!artifact || Array.isArray(artifact) || typeof artifact !== "object") {
    throw new Error("invalid artifact");
  }
  const sha256 = stringClaim(artifact.sha256, "artifact.sha256");
  if (!/^[a-f0-9]{64}$/.test(sha256)) {
    throw new Error("invalid artifact.sha256");
  }
  return Object.freeze({ sha256 });
}

function normalizeClaims(claims, policy) {
  const now = Number.isSafeInteger(policy.now) ? policy.now : Math.floor(Date.now() / 1000);
  const skew = Number.isSafeInteger(policy.clockSkewSeconds) ? policy.clockSkewSeconds : 30;
  const issuer = stringClaim(claims.iss, "iss");
  if (issuer !== policy.issuer) throw new Error("issuer mismatch");
  if (!audienceMatches(claims.aud, policy.audience)) throw new Error("audience mismatch");

  const iat = integerDate(claims.iat, "iat");
  const exp = integerDate(claims.exp, "exp");
  if (iat > now + skew) throw new Error("token issued in future");
  if (now - skew >= exp) throw new Error("token expired");
  if (exp <= iat) throw new Error("invalid token lifetime");
  const maxTtlSeconds = Number.isSafeInteger(policy.maxTtlSeconds)
    ? policy.maxTtlSeconds
    : 300;
  if (maxTtlSeconds < 60 || maxTtlSeconds > 900 || exp - iat > maxTtlSeconds) {
    throw new Error("token lifetime exceeds policy");
  }
  if (claims.nbf !== undefined && now + skew < integerDate(claims.nbf, "nbf")) {
    throw new Error("token not active");
  }
  const proof = normalizeProof(claims.proof, policy, now, skew);

  const capabilities = stringArray(claims.capabilities, "capabilities");
  if (!capabilities.includes(CAPABILITY)) throw new Error("missing fallback capability");

  return Object.freeze({
    issuer,
    subject: stringClaim(claims.sub, "sub"),
    audience: claims.aud,
    iat,
    exp,
    nbf: claims.nbf,
    jti: stringClaim(claims.jti, "jti"),
    proof,
    capabilities: Object.freeze(capabilities),
    package: normalizePackage(claims.package),
    source: normalizeSource(claims.source),
    artifact: normalizeArtifact(claims.artifact),
  });
}

function selectKey(header, keys) {
  const alg = stringClaim(header.alg, "alg");
  const algorithm = SUPPORTED_ALGORITHMS[alg];
  if (!algorithm) throw new Error("unsupported alg");
  if (header.typ !== undefined && header.typ !== "JWT") throw new Error("invalid typ");
  const kid = stringClaim(header.kid, "kid");
  const candidates = Array.isArray(keys) ? keys : [];
  const jwk = candidates.find((entry) => entry && entry.kid === kid && (!entry.alg || entry.alg === alg));
  if (!jwk) throw new Error("unknown signing key");
  return { alg, algorithm, jwk };
}

export async function verifyEdgeCapability(token, policy) {
  if (!policy || typeof policy !== "object") throw new Error("invalid policy");
  stringClaim(policy.issuer, "policy.issuer");
  stringClaim(policy.audience, "policy.audience");

  const parsed = parseCompactJwt(token);
  const selected = selectKey(parsed.header, policy.keys);
  const key = await crypto.subtle.importKey(
    "jwk",
    selected.jwk,
    selected.algorithm.importAlgorithm,
    false,
    ["verify"],
  );
  const signed = new TextEncoder().encode(`${parsed.encodedHeader}.${parsed.encodedPayload}`);
  const valid = await crypto.subtle.verify(
    selected.algorithm.verifyAlgorithm,
    key,
    parsed.signature,
    signed,
  );
  if (!valid) throw new Error("invalid signature");
  return normalizeClaims(parsed.claims, policy);
}

function sameString(actual, expected) {
  return typeof expected === "string" && expected.length > 0 && actual === expected;
}

export function authorizeFallback(capability, request) {
  if (!capability || !request) return false;
  if (request.capability !== CAPABILITY) return false;
  if (!sameString(capability.package?.org, request.package?.org)) return false;
  if (!sameString(capability.package?.name, request.package?.name)) return false;
  if (!sameString(capability.source?.provider, request.source?.provider)) return false;

  if (request.source.provider === "github") {
    return (
      sameString(capability.source.owner, request.source.owner) &&
      sameString(capability.source.repo, request.source.repo)
    );
  }
  if (request.source.provider === "npm") {
    return (
      sameString(capability.source.scope, request.source.scope) &&
      sameString(capability.source.package, request.source.package)
    );
  }
  if (request.source.provider === "cargo-registry") {
    return (
      sameString(capability.source.registry, request.source.registry) &&
      sameString(capability.source.package, request.source.package)
    );
  }
  return false;
}

export function authorizePrivateArtifact(capability, sha256) {
  return (
    Boolean(capability) &&
    typeof sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(sha256) &&
    capability.capabilities?.includes(CAPABILITY) === true &&
    capability.proof?.reconciliation === "reconciled" &&
    capability.artifact?.sha256 === sha256
  );
}

export function privateFallbackHeaders(providerCredential) {
  if (!providerCredential || typeof providerCredential !== "object") return null;
  const provider = providerCredential.provider;
  const token = providerCredential.token;
  if (!SOURCE_PROVIDERS.has(provider) || typeof token !== "string" || token.length === 0) {
    return null;
  }
  const headers = new Headers({
    "cache-control": "private, no-store",
    pragma: "no-cache",
  });
  if (provider === "github") headers.set("authorization", `Bearer ${token}`);
  if (provider === "npm") headers.set("authorization", `Bearer ${token}`);
  if (provider === "cargo-registry") headers.set("authorization", `Bearer ${token}`);
  return headers;
}

export const EDGE_FALLBACK_CAPABILITY = CAPABILITY;
