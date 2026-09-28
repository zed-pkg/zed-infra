const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,191}$/;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.!_+~-]{0,127}$/;
const SHA256 = /^[a-f0-9]{64}$/;

export const CPAN_METADATA_BASE = "https://fastapi.metacpan.org/v1/download_url";
export const CRAN_METADATA_BASE = "https://cran.r-project.org/web/packages";

export function cpanMetadataUrl(name, version = null) {
  if (!safeSimple(name) || (version !== null && !safeVersion(version))) {
    return null;
  }
  const url = new URL(`${CPAN_METADATA_BASE}/${encodeURIComponent(name)}`);
  if (version !== null) {
    url.searchParams.set("version", version);
  }
  return url.toString();
}

export function cpanDownload(body, name, requestedVersion) {
  if (!body || typeof body !== "object" || !safeSimple(name) || !safeVersion(requestedVersion)) {
    return null;
  }
  if (body.version !== requestedVersion || !SHA256.test(body.checksum_sha256 || "")) {
    return null;
  }
  const expectedRelease = `${name}-${requestedVersion}`;
  if (body.release !== expectedRelease || typeof body.download_url !== "string") {
    return null;
  }
  let url;
  try {
    url = new URL(body.download_url);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "cpan.metacpan.org" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash ||
    !url.pathname.startsWith("/authors/id/") ||
    safeFilename(url.pathname) !== `${expectedRelease}.tar.gz`
  ) {
    return null;
  }
  const size = Number(body.size ?? body.stat?.size ?? 0);
  return {
    url: url.toString(),
    sha256: body.checksum_sha256,
    size: Number.isSafeInteger(size) && size > 0 ? size : 0,
    format: "tar.gz",
    published_at: safeDate(body.date),
  };
}

export function cpanVersions(body) {
  if (!body || typeof body !== "object" || !safeVersion(body.version)) {
    return [];
  }
  return [body.version];
}

export function cranMetadataUrl(name) {
  if (!safeSimple(name)) {
    return null;
  }
  return `${CRAN_METADATA_BASE}/${encodeURIComponent(name)}/DESCRIPTION`;
}

export function isCranDescriptionResponse(response, contentType) {
  if (!/^text\/plain(?:\s*;|$)/i.test(contentType || "")) {
    return false;
  }
  if (typeof response?.url !== "string" || !response.url) {
    return false;
  }
  let url;
  try {
    url = new URL(response.url);
  } catch {
    return false;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "cran.r-project.org" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return false;
  }
  const match = url.pathname.match(/^\/web\/packages\/([^/]+)\/DESCRIPTION$/);
  if (!match) {
    return false;
  }
  let name;
  try {
    name = decodeURIComponent(match[1]);
  } catch {
    return false;
  }
  return safeSimple(name);
}

export function parseCranDescription(text) {
  if (typeof text !== "string" || text.length === 0) {
    return null;
  }
  const allowed = new Set(["Package", "Version", "Title", "Description", "URL", "BugReports"]);
  const result = {};
  let active = null;
  for (const rawLine of text.split(/\r?\n/)) {
    if (/^[ \t]/.test(rawLine) && active) {
      result[active] = `${result[active]} ${rawLine.trim()}`.trim();
      continue;
    }
    const separator = rawLine.indexOf(":");
    if (separator <= 0) {
      active = null;
      continue;
    }
    const key = rawLine.slice(0, separator).trim();
    if (!allowed.has(key)) {
      active = null;
      continue;
    }
    result[key] = rawLine.slice(separator + 1).trim();
    active = key;
  }
  if (!safeSimple(result.Package) || !safeVersion(result.Version)) {
    return null;
  }
  return result;
}

export function cranDownload(body, name, requestedVersion) {
  if (!body || typeof body !== "object" || !safeSimple(name) || !safeVersion(requestedVersion)) {
    return null;
  }
  if (body.Package !== name || body.Version !== requestedVersion) {
    return null;
  }
  const url = `https://cran.r-project.org/src/contrib/${encodeURIComponent(name)}_${encodeURIComponent(requestedVersion)}.tar.gz`;
  return {
    url,
    sha256: "",
    size: 0,
    format: "tar.gz",
  };
}

export function cranVersions(body) {
  if (!body || typeof body !== "object" || !safeVersion(body.Version)) {
    return [];
  }
  return [body.Version];
}

export function stagedPackageDescription(id, body) {
  if (id === "cran") {
    return body?.Description || body?.Title || null;
  }
  return null;
}

export function stagedRepoUrl(id, name) {
  if (!safeSimple(name)) {
    return null;
  }
  if (id === "cpan") {
    return `https://metacpan.org/dist/${encodeURIComponent(name)}`;
  }
  if (id === "cran") {
    return `https://cran.r-project.org/web/packages/${encodeURIComponent(name)}/`;
  }
  return null;
}

function safeSimple(value) {
  return (
    typeof value === "string" &&
    SAFE_NAME.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function safeVersion(value) {
  return (
    typeof value === "string" &&
    SAFE_VERSION.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\")
  );
}

function safeFilename(pathname) {
  let decoded;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  return decoded.split("/").at(-1) || null;
}

function safeDate(value) {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) {
    return null;
  }
  return new Date(timestamp).toISOString();
}
