const SAFE_GROUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;
const SAFE_ARTIFACT = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,191}$/;
const SAFE_VERSION = /^[0-9A-Za-z][0-9A-Za-z.!_+~-]{0,127}$/;

export const CLOJARS_METADATA_BASE = "https://clojars.org/api/artifacts";
export const CLOJARS_REPOSITORY_BASE = "https://repo.clojars.org";

export function clojarsCoordinate(coordinate) {
  if (typeof coordinate !== "string") {
    return null;
  }
  const parts = coordinate.split(":");
  if (
    parts.length !== 2 ||
    !SAFE_GROUP.test(parts[0]) ||
    !SAFE_ARTIFACT.test(parts[1]) ||
    parts[0].includes("..") ||
    parts[1].includes("..") ||
    parts[0].includes("/") ||
    parts[1].includes("/") ||
    parts[0].includes("\\") ||
    parts[1].includes("\\")
  ) {
    return null;
  }
  return parts;
}

export function clojarsMetadataUrl(coordinate) {
  const parts = clojarsCoordinate(coordinate);
  if (!parts) {
    return null;
  }
  const [group, artifact] = parts;
  return `${CLOJARS_METADATA_BASE}/${encodeURIComponent(group)}/${encodeURIComponent(artifact)}`;
}

export function clojarsVersions(body, coordinate) {
  const parts = clojarsCoordinate(coordinate);
  if (!parts || !body || typeof body !== "object") {
    return [];
  }
  const [group, artifact] = parts;
  if (body.group_name !== group || body.jar_name !== artifact || !Array.isArray(body.recent_versions)) {
    return [];
  }

  const versions = [];
  const seen = new Set();
  for (const row of body.recent_versions) {
    const version = row?.version;
    if (!isStableVersion(version) || seen.has(version)) {
      continue;
    }
    seen.add(version);
    versions.push(version);
  }
  return versions;
}

export function clojarsDownload(body, coordinate, requestedVersion) {
  const parts = clojarsCoordinate(coordinate);
  if (!parts || !isStableVersion(requestedVersion)) {
    return null;
  }
  if (!clojarsVersions(body, coordinate).includes(requestedVersion)) {
    return null;
  }
  const [group, artifact] = parts;
  const groupPath = group.split(".").map(encodeURIComponent).join("/");
  const encodedArtifact = encodeURIComponent(artifact);
  const encodedVersion = encodeURIComponent(requestedVersion);
  return {
    url: `${CLOJARS_REPOSITORY_BASE}/${groupPath}/${encodedArtifact}/${encodedVersion}/${encodedArtifact}-${encodedVersion}.jar`,
    sha256: "",
    size: 0,
    format: "zip",
  };
}

export function isAllowedClojarsDownloadUrl(rawUrl, coordinate, requestedVersion) {
  const candidate = clojarsDownload(
    {
      group_name: clojarsCoordinate(coordinate)?.[0],
      jar_name: clojarsCoordinate(coordinate)?.[1],
      recent_versions: [{ version: requestedVersion }],
    },
    coordinate,
    requestedVersion,
  );
  if (!candidate || candidate.url !== rawUrl) {
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
    url.hostname === "repo.clojars.org" &&
    !url.username &&
    !url.password &&
    !url.port &&
    !url.search &&
    !url.hash
  );
}

export function clojarsLatest(body, coordinate, versions) {
  const candidate = body?.latest_release;
  if (typeof candidate === "string" && versions.includes(candidate)) {
    return candidate;
  }
  return versions[0] || null;
}

export function clojarsDescription(body) {
  return typeof body?.description === "string" && body.description.trim()
    ? body.description.trim()
    : null;
}

export function clojarsRepoUrl(body, coordinate) {
  const scm = body?.scm?.url;
  if (typeof scm === "string") {
    const safe = safeHttpsUrl(scm);
    if (safe) {
      return safe;
    }
  }
  const parts = clojarsCoordinate(coordinate);
  if (!parts) {
    return null;
  }
  return `https://clojars.org/${encodeURIComponent(parts[0])}/${encodeURIComponent(parts[1])}`;
}

function isStableVersion(value) {
  return (
    typeof value === "string" &&
    SAFE_VERSION.test(value) &&
    !value.includes("..") &&
    !value.includes("/") &&
    !value.includes("\\") &&
    !/-SNAPSHOT$/i.test(value)
  );
}

function safeHttpsUrl(value) {
  let url;
  try {
    url = new URL(value.replace(/^git\+/, "").replace(/\.git$/, ""));
  } catch {
    return null;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port) {
    return null;
  }
  return url.toString().replace(/\/$/, "");
}
