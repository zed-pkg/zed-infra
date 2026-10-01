import {
  NATIVE_REGISTRIES,
  decodeAndValidateNativeCoordinate,
} from "./native-registry-catalog.js";

const API_BASE = "https://rubygems.org/api/v1/versions";
const DOWNLOAD_BASE = "https://rubygems.org/downloads";
const SHA256 = /^[a-f0-9]{64}$/;
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.!_+~-]{0,127}$/;

export function rubyGemsCoordinate(encodedOrLegacy) {
  return decodeAndValidateNativeCoordinate(
    NATIVE_REGISTRIES.rubygems,
    encodedOrLegacy,
  );
}

export function rubyGemsVersionsUrl(encodedOrLegacy) {
  const name = rubyGemsCoordinate(encodedOrLegacy);
  if (!name) {
    return null;
  }
  return `${API_BASE}/${encodeURIComponent(name)}.json`;
}

export function rubyGemsVersions(body) {
  if (!Array.isArray(body)) {
    return [];
  }
  return body
    .filter(isRubyPlatformRelease)
    .map((row) => row.number)
    .filter(isSafeVersion)
    .sort(sortVersionsDesc);
}

export function rubyGemsDownload(body, encodedOrLegacy, version) {
  const name = rubyGemsCoordinate(encodedOrLegacy);
  if (!name || !isSafeVersion(version) || !Array.isArray(body)) {
    return null;
  }
  const release = body.find(
    (row) => isRubyPlatformRelease(row) && row.number === version,
  );
  if (!release || !SHA256.test(release.sha || "")) {
    return null;
  }
  return {
    url: `${DOWNLOAD_BASE}/${encodeURIComponent(name)}-${encodeURIComponent(version)}.gem`,
    sha256: release.sha,
    size: 0,
    native_format: "gem",
    published_at: safeTimestamp(release.created_at),
  };
}

export function isAllowedRubyGemsDownloadUrl(rawUrl, encodedOrLegacy, version) {
  const name = rubyGemsCoordinate(encodedOrLegacy);
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
    url.hostname === "rubygems.org" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash &&
    url.pathname === `/downloads/${encodeURIComponent(name)}-${encodeURIComponent(version)}.gem`
  );
}

function isRubyPlatformRelease(row) {
  return (
    row &&
    typeof row === "object" &&
    row.platform === "ruby" &&
    row.prerelease !== true &&
    isSafeVersion(row.number)
  );
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
