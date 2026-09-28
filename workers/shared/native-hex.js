import {
  NATIVE_REGISTRIES,
  decodeAndValidateNativeCoordinate,
} from "./native-registry-catalog.js";

const API_BASE = "https://hex.pm/api/packages";
const REPO_BASE = "https://repo.hex.pm/tarballs";
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9][0-9A-Za-z.!_+~-]{0,127}$/;

export function hexCoordinate(encodedOrLegacy) {
  return decodeAndValidateNativeCoordinate(NATIVE_REGISTRIES.hex, encodedOrLegacy);
}

export function hexPackageUrl(encodedOrLegacy) {
  const name = hexCoordinate(encodedOrLegacy);
  if (!name) {
    return null;
  }
  return `${API_BASE}/${encodeURIComponent(name)}`;
}

export function hexReleaseUrl(encodedOrLegacy, version) {
  const name = hexCoordinate(encodedOrLegacy);
  if (!name || !isSafeVersion(version)) {
    return null;
  }
  return `${API_BASE}/${encodeURIComponent(name)}/releases/${encodeURIComponent(version)}`;
}

export function hexVersions(body) {
  if (!isPublicPackageBody(body)) {
    return [];
  }
  const retired = body.retirements && typeof body.retirements === "object"
    ? new Set(Object.keys(body.retirements))
    : new Set();
  return (body.releases || [])
    .map((release) => release?.version)
    .filter(isSafeVersion)
    .filter((version) => !retired.has(version))
    .sort(sortVersionsDesc);
}

export function hexDownload(body, encodedOrLegacy, version) {
  const name = hexCoordinate(encodedOrLegacy);
  if (!name || !isSafeVersion(version) || !isExactReleaseBody(body, name, version)) {
    return null;
  }
  if (body.retirement || !SHA256.test(body.checksum || "")) {
    return null;
  }
  return {
    url: `${REPO_BASE}/${encodeURIComponent(name)}-${encodeURIComponent(version)}.tar`,
    sha256: body.checksum,
    size: 0,
    native_format: "hex-tar",
    published_at: safeTimestamp(body.inserted_at),
  };
}

export function isAllowedHexDownloadUrl(rawUrl, encodedOrLegacy, version) {
  const name = hexCoordinate(encodedOrLegacy);
  if (!name || !isSafeVersion(version)) {
    return false;
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    url.hostname === "repo.hex.pm" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    url.pathname === `/tarballs/${encodeURIComponent(name)}-${encodeURIComponent(version)}.tar`
  );
}

export function isPublicPackageBody(body) {
  return Boolean(
    body &&
    typeof body === "object" &&
    !Array.isArray(body) &&
    body.repository === "hexpm" &&
    typeof body.name === "string" &&
    hexCoordinate(body.name) === body.name &&
    Array.isArray(body.releases),
  );
}

function isExactReleaseBody(body, name, version) {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return false;
  }
  if (body.version !== version) {
    return false;
  }
  const packageUrl = `${API_BASE}/${encodeURIComponent(name)}`;
  const releaseUrl = `${packageUrl}/releases/${encodeURIComponent(version)}`;
  return body.package_url === packageUrl && body.url === releaseUrl;
}

function isSafeVersion(value) {
  return (
    typeof value === "string" &&
    VERSION.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function safeTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function sortVersionsDesc(a, b) {
  return String(b).localeCompare(String(a), undefined, {
    numeric: true,
    sensitivity: "base",
  });
}
