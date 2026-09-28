const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.!_+~-]{0,127}$/;
const GIT_REFERENCE = /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/;

export const PACKAGIST_METADATA_BASE = "https://repo.packagist.org/p2";

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

/**
 * Expand Composer 2 metadata-minifier deltas.
 *
 * Composer's reference implementation is shallow: each entry starts from the
 * previous expanded version, changed top-level keys overwrite it, and the
 * literal `__unset` removes one inherited top-level key.
 */
export function expandPackagistVersions(body, coordinate) {
  if (!body || typeof body !== "object" || !packagistCoordinate(coordinate)) {
    return [];
  }
  const versions = body.packages?.[coordinate];
  if (!Array.isArray(versions)) {
    return [];
  }
  if (body.minified !== undefined && body.minified !== "composer/2.0") {
    return [];
  }
  if (body.minified !== "composer/2.0") {
    return versions.map(cloneRecord).filter(Boolean);
  }

  const expanded = [];
  let previous = null;
  for (const delta of versions) {
    if (!plainRecord(delta)) {
      return [];
    }
    if (previous === null) {
      previous = cloneRecord(delta);
      if (!previous) {
        return [];
      }
      expanded.push(previous);
      continue;
    }

    const next = { ...previous };
    for (const [key, value] of Object.entries(delta)) {
      if (value === "__unset") {
        delete next[key];
      } else {
        next[key] = value;
      }
    }
    previous = next;
    expanded.push(next);
  }
  return expanded;
}

export function packagistVersions(body, coordinate) {
  const versions = [];
  const seen = new Set();
  for (const entry of expandPackagistVersions(body, coordinate)) {
    const binding = packagistGithubZip(entry, coordinate);
    if (!binding || seen.has(entry.version)) {
      continue;
    }
    seen.add(entry.version);
    versions.push(entry.version);
  }
  return versions;
}

export function packagistDownload(body, coordinate, requestedVersion) {
  if (!isSafeVersion(requestedVersion)) {
    return null;
  }
  const entry = expandPackagistVersions(body, coordinate).find(
    (candidate) => candidate?.version === requestedVersion,
  );
  const binding = packagistGithubZip(entry, coordinate);
  if (!binding) {
    return null;
  }

  const { owner, repo, reference } = binding;
  return {
    url: `https://codeload.github.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/zip/${reference}`,
    sha256: "",
    size: 0,
    format: "zip",
    published_at: safeTimestamp(entry.time),
    validation: {
      kind: "packagist-github-zip",
      owner,
      repo,
      reference,
    },
  };
}

export function isAllowedPackagistDownloadUrl(rawUrl, candidate) {
  const binding = candidate?.validation;
  if (
    binding?.kind !== "packagist-github-zip" ||
    !safeGithubPart(binding.owner) ||
    !safeGithubPart(binding.repo) ||
    !GIT_REFERENCE.test(binding.reference || "")
  ) {
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

  const expectedPath = `/${encodeURIComponent(binding.owner)}/${encodeURIComponent(binding.repo)}/zip/${binding.reference}`;
  return url.pathname === expectedPath && rawUrl === candidate.url;
}

export function packagistLatest(body, coordinate, versions) {
  for (const entry of expandPackagistVersions(body, coordinate)) {
    if (typeof entry?.version === "string" && versions.includes(entry.version)) {
      return entry.version;
    }
  }
  return versions[0] || null;
}

export function packagistDescription(body, coordinate) {
  for (const entry of expandPackagistVersions(body, coordinate)) {
    if (typeof entry?.description === "string" && entry.description.trim()) {
      return entry.description.trim();
    }
  }
  return null;
}

export function packagistRepoUrl(body, coordinate) {
  for (const entry of expandPackagistVersions(body, coordinate)) {
    const binding = packagistGithubZip(entry, coordinate);
    if (binding) {
      return `https://github.com/${binding.owner}/${binding.repo}`;
    }
  }
  const parts = packagistCoordinate(coordinate);
  if (!parts) {
    return null;
  }
  return `https://packagist.org/packages/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

function packagistGithubZip(entry, coordinate) {
  if (!plainRecord(entry) || entry.name !== coordinate || !isSafeVersion(entry.version)) {
    return null;
  }
  if (!plainRecord(entry.dist) || entry.dist.type !== "zip") {
    return null;
  }
  if (entry.dist.shasum !== undefined && entry.dist.shasum !== null && entry.dist.shasum !== "") {
    // The direct codeload `/zip/` archive is semantically equivalent to the
    // GitHub API zipball but is not byte-identical to every legacy archive.
    // Never substitute representations when Packagist supplied a byte hash.
    return null;
  }

  const reference = String(entry.dist.reference || "").toLowerCase();
  if (!GIT_REFERENCE.test(reference)) {
    return null;
  }
  if (
    !plainRecord(entry.source) ||
    entry.source.type !== "git" ||
    String(entry.source.reference || "").toLowerCase() !== reference
  ) {
    return null;
  }

  const repository = githubRepository(entry.source.url);
  if (!repository) {
    return null;
  }
  const advertised = githubApiZipball(entry.dist.url);
  if (
    !advertised ||
    advertised.owner.toLowerCase() !== repository.owner.toLowerCase() ||
    advertised.repo.toLowerCase() !== repository.repo.toLowerCase() ||
    advertised.reference !== reference
  ) {
    return null;
  }
  return { ...repository, reference };
}

function githubRepository(value) {
  if (typeof value !== "string") {
    return null;
  }
  let url;
  try {
    url = new URL(value.replace(/\.git$/, ""));
  } catch {
    return null;
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
    return null;
  }
  const parts = url.pathname.replace(/^\/+|\/+$/g, "").split("/");
  if (parts.length !== 2 || !safeGithubPart(parts[0]) || !safeGithubPart(parts[1])) {
    return null;
  }
  return { owner: parts[0], repo: parts[1] };
}

function githubApiZipball(value) {
  if (typeof value !== "string") {
    return null;
  }
  let url;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (
    url.protocol !== "https:" ||
    url.hostname !== "api.github.com" ||
    url.username ||
    url.password ||
    url.port ||
    url.search ||
    url.hash
  ) {
    return null;
  }
  const match = url.pathname.match(/^\/repos\/([^/]+)\/([^/]+)\/zipball\/([a-f0-9]{40}|[a-f0-9]{64})$/i);
  if (!match) {
    return null;
  }
  let owner;
  let repo;
  try {
    owner = decodeURIComponent(match[1]);
    repo = decodeURIComponent(match[2]);
  } catch {
    return null;
  }
  if (!safeGithubPart(owner) || !safeGithubPart(repo)) {
    return null;
  }
  return { owner, repo, reference: match[3].toLowerCase() };
}

function isSafeVersion(value) {
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

function safeGithubPart(value) {
  return (
    typeof value === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._-]{0,99}$/.test(value) &&
    !value.includes("..")
  );
}

function safeTimestamp(value) {
  if (typeof value !== "string") {
    return null;
  }
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function plainRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function cloneRecord(value) {
  return plainRecord(value) ? { ...value } : null;
}
