const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.!_+~-]{0,127}$/;
const GIT_SHA = /^[a-f0-9]{40}$/;

export const PACKAGIST_METADATA_BASE = "https://packagist.org/packages";

export function packagistCoordinate(coordinate) {
  if (typeof coordinate !== "string" || coordinate.includes("..") || coordinate.includes("\\")) {
    return null;
  }
  const parts = coordinate.split("/");
  if (parts.length !== 2 || !parts.every((part) => SAFE_COMPONENT.test(part))) {
    return null;
  }
  return parts;
}

export function packagistMetadataUrl(coordinate) {
  const parts = packagistCoordinate(coordinate);
  if (!parts) {
    return null;
  }
  return `${PACKAGIST_METADATA_BASE}/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}.json`;
}

export function packagistVersions(body, coordinate) {
  const parts = packagistCoordinate(coordinate);
  const pkg = body?.package;
  if (!parts || !pkg || typeof pkg !== "object" || pkg.name !== coordinate) {
    return [];
  }
  if (!isExactGithubRepository(pkg.repository, parts[0], parts[1])) {
    return [];
  }
  const versions = pkg.versions;
  if (!versions || typeof versions !== "object" || Array.isArray(versions)) {
    return [];
  }
  const accepted = [];
  const seen = new Set();
  for (const row of Object.values(versions)) {
    const version = row?.version;
    if (!isStableVersion(version) || seen.has(version)) {
      continue;
    }
    if (!packagistDownload(body, coordinate, version)) {
      continue;
    }
    seen.add(version);
    accepted.push(version);
  }
  return accepted.sort(sortVersionsDesc);
}

export function packagistDownload(body, coordinate, requestedVersion) {
  const parts = packagistCoordinate(coordinate);
  const pkg = body?.package;
  if (!parts || !pkg || pkg.name !== coordinate || !isStableVersion(requestedVersion)) {
    return null;
  }
  if (!isExactGithubRepository(pkg.repository, parts[0], parts[1])) {
    return null;
  }
  const rows = Object.values(pkg.versions || {});
  const row = rows.find((candidate) => candidate?.version === requestedVersion);
  if (!row || row.dist?.type !== "zip" || row.source?.type !== "git") {
    return null;
  }
  const reference = String(row.dist?.reference || "").toLowerCase();
  const sourceReference = String(row.source?.reference || "").toLowerCase();
  if (!GIT_SHA.test(reference) || sourceReference !== reference) {
    return null;
  }
  if (!isExactGithubRepository(row.source?.url, parts[0], parts[1])) {
    return null;
  }
  const advertisedUrl = `https://api.github.com/repos/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/zipball/${reference}`;
  if (row.dist?.url !== advertisedUrl) {
    return null;
  }

  // Fetch the immutable codeload URL directly instead of following the GitHub
  // API redirect. This keeps the metadata-bound commit reference in the URL
  // that the generic edge downloader validates at every hop.
  const url = `https://codeload.github.com/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}/legacy.zip/${reference}`;
  return {
    url,
    sha256: "",
    size: 0,
    format: "zip",
    published_at: safeTimestamp(row.time),
    reference,
  };
}

export function isAllowedPackagistDownloadUrl(rawUrl, coordinate, requestedVersion, reference = null) {
  const parts = packagistCoordinate(coordinate);
  if (!parts || !isStableVersion(requestedVersion) || typeof rawUrl !== "string") {
    return false;
  }
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "codeload.github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return false;
  }

  const match = url.pathname.match(/^\/([^/]+)\/([^/]+)\/legacy\.zip\/([a-f0-9]{40})$/);
  if (!match) {
    return false;
  }
  const owner = parts[0].toLowerCase();
  const repo = parts[1].toLowerCase();
  const expectedReference = typeof reference === "string" ? reference.toLowerCase() : null;
  if (expectedReference && !GIT_SHA.test(expectedReference)) {
    return false;
  }
  return (
    decodeURIComponent(match[1]).toLowerCase() === owner &&
    decodeURIComponent(match[2]).toLowerCase() === repo &&
    (!expectedReference || match[3] === expectedReference)
  );
}

export function packagistDescription(body) {
  const value = body?.package?.description;
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

export function packagistRepoUrl(body, coordinate) {
  const parts = packagistCoordinate(coordinate);
  if (!parts || !isExactGithubRepository(body?.package?.repository, parts[0], parts[1])) {
    return null;
  }
  return `https://github.com/${parts[0]}/${parts[1]}`;
}

function isExactGithubRepository(value, owner, repo) {
  if (typeof value !== "string") {
    return false;
  }
  let url;
  try {
    url = new URL(value.replace(/\.git$/, ""));
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  const segments = url.pathname.split("/").filter(Boolean);
  return (
    segments.length === 2 &&
    segments[0].toLowerCase() === owner.toLowerCase() &&
    segments[1].toLowerCase() === repo.toLowerCase()
  );
}

function isStableVersion(value) {
  return (
    typeof value === "string" &&
    SAFE_VERSION.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/^dev-/i.test(value) &&
    !/-dev$/i.test(value)
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
  return String(b).localeCompare(String(a), undefined, { numeric: true, sensitivity: "base" });
}
