/**
 * Public native-registry fallback for zpkg.net edge workers.
 *
 * When the zed-api-server origin is down, `registry.zpkg.net` and
 * `cdn.zpkg.net` may reconstruct reads from well-known *public* package
 * APIs (npmjs, crates.io, PyPI, …). This file is binding-free so Node
 * tests can import it.
 *
 * Private / high-likelihood-private packages are never proxied:
 * - no Authorization header is sent to these hosts
 * - 401 / 403 / 404 / unpublished / `private: true` are treated as a miss
 * - enterprise mirrors (Artifactory, GitHub Packages private, TestPyPI)
 *   are not in this table
 *
 * Org tokens match `zed-interfaces` `NativeHost::from_token` / `as_str`.
 */

import { isSlug, USER_AGENT } from "./github-fallback.js";

const NAME = /^[A-Za-z0-9._+-]+$/;

/** Canonical host id → public read endpoints. */
export const PUBLIC_NATIVE_HOSTS = {
  npm: {
    id: "npm",
    aliases: ["npm", "npmjs", "npmjs.com"],
    metadata: "https://registry.npmjs.org",
    artifacts: "https://registry.npmjs.org",
  },
  "crates-io": {
    id: "crates-io",
    aliases: ["crates-io", "crates.io", "cargo"],
    metadata: "https://crates.io/api/v1",
    artifacts: "https://static.crates.io/crates",
  },
  pypi: {
    id: "pypi",
    aliases: ["pypi", "pypi.org"],
    metadata: "https://pypi.org/pypi",
    artifacts: "https://files.pythonhosted.org",
  },
  rubygems: {
    id: "rubygems",
    aliases: ["rubygems", "rubygems.org", "gem"],
    metadata: "https://rubygems.org/api/v1",
    artifacts: "https://rubygems.org/gems",
  },
  hex: {
    id: "hex",
    aliases: ["hex", "hex.pm"],
    metadata: "https://hex.pm/api",
    artifacts: "https://repo.hex.pm/tarballs",
  },
  "pub-dev": {
    id: "pub-dev",
    aliases: ["pub-dev", "pub.dev", "pub"],
    metadata: "https://pub.dev/api",
    artifacts: "https://pub.dev/api",
  },
  nuget: {
    id: "nuget",
    aliases: ["nuget", "nuget.org"],
    metadata: "https://api.nuget.org/v3-flatcontainer",
    artifacts: "https://api.nuget.org/v3-flatcontainer",
  },
  "go-proxy": {
    id: "go-proxy",
    aliases: ["go-proxy", "goproxy", "go-modules", "golang"],
    metadata: "https://proxy.golang.org",
    artifacts: "https://proxy.golang.org",
  },
  hackage: {
    id: "hackage",
    aliases: ["hackage"],
    metadata: "https://hackage.haskell.org",
    artifacts: "https://hackage.haskell.org/package",
  },
  packagist: {
    id: "packagist",
    aliases: ["packagist", "packagist.org", "composer"],
    metadata: "https://repo.packagist.org/p2",
    artifacts: "https://repo.packagist.org/p2",
  },
};

const ALIAS_TO_HOST = new Map();
for (const host of Object.values(PUBLIC_NATIVE_HOSTS)) {
  for (const alias of host.aliases) {
    ALIAS_TO_HOST.set(alias, host);
  }
}

export function normalizeOrgToken(org) {
  if (typeof org !== "string") return "";
  return org
    .trim()
    .toLowerCase()
    .replace(/[_ ]/g, "-");
}

/**
 * Map a zed org slug to a public native host, or null.
 * Unknown orgs (including GitHub owners) stay on the GitHub fallback.
 */
export function publicNativeHostFromOrg(org) {
  return ALIAS_TO_HOST.get(normalizeOrgToken(org)) || null;
}

export function isSafePackageName(name) {
  return (
    typeof name === "string" &&
    NAME.test(name) &&
    !name.includes("..") &&
    name.length >= 1 &&
    name.length <= 128
  );
}

/**
 * High-likelihood public: well-known public host + safe name + no
 * private-package markers. Scoped npm (`@scope/name`) is accepted only
 * when both halves are slugs; we never attach credentials.
 */
export function isHighLikelihoodPublic(host, name) {
  if (!host || !isSafePackageName(name)) return false;
  const lower = name.toLowerCase();
  if (lower.includes("private") && /(?:^|[-_.])private(?:[-_.]|$)/.test(lower)) {
    return false;
  }
  if (lower.startsWith("internal-") || lower.endsWith("-internal")) {
    return false;
  }
  return true;
}

export function nativeHeaders() {
  return {
    Accept: "application/json",
    "User-Agent": USER_AGENT,
  };
}

export function encodeNpmName(name) {
  if (name.startsWith("@")) {
    const [scope, pkg] = name.split("/");
    if (scope && pkg) return `${encodeURIComponent(scope)}/${encodeURIComponent(pkg)}`;
  }
  return encodeURIComponent(name);
}

export function nativePackageMetadataUrl(host, name) {
  if (!host || !isHighLikelihoodPublic(host, name)) return null;
  switch (host.id) {
    case "npm":
      return `${host.metadata}/${encodeNpmName(name)}`;
    case "crates-io":
      return `${host.metadata}/crates/${encodeURIComponent(name)}`;
    case "pypi":
      return `${host.metadata}/${encodeURIComponent(name)}/json`;
    case "rubygems":
      return `${host.metadata}/gems/${encodeURIComponent(name)}.json`;
    case "hex":
      return `${host.metadata}/packages/${encodeURIComponent(name)}`;
    case "pub-dev":
      return `${host.metadata}/packages/${encodeURIComponent(name)}`;
    case "nuget":
      return `${host.metadata}/${encodeURIComponent(name.toLowerCase())}/index.json`;
    case "hackage":
      return `${host.metadata}/package/${encodeURIComponent(name)}.json`;
    case "packagist": {
      const vendor = packagistVendorName(name);
      return vendor
        ? `${host.metadata}/${encodeURIComponent(vendor.vendor)}/${encodeURIComponent(vendor.package)}.json`
        : null;
    }
    case "go-proxy":
      return `${host.metadata}/${name}/@v/list`;
    default:
      return null;
  }
}

export function nativeVersionMetadataUrl(host, name, version) {
  if (!host || !isHighLikelihoodPublic(host, name) || !version) return null;
  switch (host.id) {
    case "npm":
      return `${host.metadata}/${encodeNpmName(name)}/${encodeURIComponent(version)}`;
    case "crates-io":
      return `${host.metadata}/crates/${encodeURIComponent(name)}/${encodeURIComponent(version)}`;
    case "pypi":
      return `${host.metadata}/${encodeURIComponent(name)}/${encodeURIComponent(version)}/json`;
    case "rubygems":
      return `https://rubygems.org/api/v2/rubygems/${encodeURIComponent(name)}/versions/${encodeURIComponent(version)}.json`;
    case "hex":
      return `${host.metadata}/packages/${encodeURIComponent(name)}`;
    case "pub-dev":
      return `${host.metadata}/packages/${encodeURIComponent(name)}`;
    case "nuget":
      return `${host.artifacts}/${encodeURIComponent(name.toLowerCase())}/${encodeURIComponent(version.toLowerCase())}/${encodeURIComponent(name.toLowerCase())}.nuspec`;
    case "hackage":
      return `${host.metadata}/package/${encodeURIComponent(name)}-${encodeURIComponent(version)}`;
    case "go-proxy":
      return `${host.metadata}/${name}/@v/${encodeURIComponent(version)}.info`;
    default:
      return nativePackageMetadataUrl(host, name);
  }
}

export function nativeTarballUrls(host, name, version, filename) {
  if (!host || !isHighLikelihoodPublic(host, name) || !version) return [];
  const urls = [];
  switch (host.id) {
    case "npm":
      urls.push(
        `${host.artifacts}/${encodeNpmName(name)}/-/${encodeURIComponent(filename || `${name}-${version}.tgz`)}`,
      );
      break;
    case "crates-io":
      urls.push(
        `${host.artifacts}/${encodeURIComponent(name)}/${encodeURIComponent(name)}-${encodeURIComponent(version)}.crate`,
      );
      break;
    case "pypi":
      if (filename) {
        urls.push(
          `https://files.pythonhosted.org/packages/source/${name[0]}/${encodeURIComponent(name)}/${encodeURIComponent(filename)}`,
        );
      }
      break;
    case "rubygems":
      urls.push(
        `${host.artifacts}/${encodeURIComponent(filename || `${name}-${version}.gem`)}`,
      );
      break;
    case "hex":
      urls.push(
        `${host.artifacts}/${encodeURIComponent(name)}-${encodeURIComponent(version)}.tar`,
      );
      break;
    case "nuget":
      urls.push(
        `${host.artifacts}/${encodeURIComponent(name.toLowerCase())}/${encodeURIComponent(version.toLowerCase())}/${encodeURIComponent(name.toLowerCase())}.${encodeURIComponent(version.toLowerCase())}.nupkg`,
      );
      break;
    case "hackage":
      urls.push(
        `${host.artifacts}/${encodeURIComponent(name)}-${encodeURIComponent(version)}/${encodeURIComponent(name)}-${encodeURIComponent(version)}.tar.gz`,
      );
      break;
    case "go-proxy":
      urls.push(`${host.artifacts}/${name}/@v/${encodeURIComponent(version)}.zip`);
      break;
    default:
      break;
  }
  return [...new Set(urls)];
}

export function packagistVendorName(name) {
  if (name.includes("/")) {
    const [vendor, pkg] = name.split("/");
    if (isSlug(vendor) && isSlug(pkg)) return { vendor, package: pkg };
    return null;
  }
  const dash = name.indexOf("-");
  if (dash <= 0 || dash === name.length - 1) return null;
  const vendor = name.slice(0, dash);
  const pkg = name.slice(dash + 1);
  if (isSlug(vendor) && isSlug(pkg)) return { vendor, package: pkg };
  return null;
}

/**
 * True when the upstream body says this package is private / unpublished.
 * Public registries normally 404 those; this is the extra belt.
 */
export function isPrivateOrUnpublished(host, body) {
  if (!body || typeof body !== "object") return true;
  if (body.private === true) return true;
  if (body.unpublished) return true;
  if (typeof body.error === "string" && /not found|unpublished|private/i.test(body.error)) {
    return true;
  }
  if (host?.id === "npm") {
    if (body.unpublished || body._unpublished) return true;
    if (!body.versions && !body.version && !body.dist) return true;
  }
  if (host?.id === "crates-io" && !body.crate && !body.version && !body.versions) {
    return true;
  }
  return false;
}

export function versionsFromNativeBody(host, body) {
  if (!body || typeof body !== "object") return [];
  switch (host?.id) {
    case "npm":
      return Object.keys(body.versions || {}).sort(sortVersionsDesc);
    case "crates-io":
      return (body.versions || [])
        .map((row) => row.num || row.vers)
        .filter(Boolean)
        .sort(sortVersionsDesc);
    case "pypi":
      return Object.keys(body.releases || {}).sort(sortVersionsDesc);
    case "rubygems":
      return [];
    case "hex":
      return (body.releases || [])
        .map((row) => row.version)
        .filter(Boolean)
        .sort(sortVersionsDesc);
    case "pub-dev":
      return (body.versions || [])
        .map((row) => row.version)
        .filter(Boolean)
        .sort(sortVersionsDesc);
    case "nuget":
      return (body.versions || []).slice().sort(sortVersionsDesc);
    default:
      return [];
  }
}

export function downloadFromNativeVersion(host, name, version, body) {
  if (!body || typeof body !== "object") return null;
  switch (host?.id) {
    case "npm": {
      const dist = body.dist || body.versions?.[version]?.dist;
      if (!dist?.tarball) return null;
      return {
        url: dist.tarball,
        sha256: integrityToSha256(dist.integrity) || "",
        size: Number(dist.unpackedSize || 0),
        format: "tar.gz",
      };
    }
    case "crates-io": {
      const crate = body.version || body.crate;
      const vers = crate?.num || crate?.vers || version;
      const urls = nativeTarballUrls(host, name, vers);
      return {
        url: crate?.dl_path
          ? `https://crates.io${crate.dl_path}`
          : urls[0],
        sha256: crate?.checksum || "",
        size: 0,
        format: "crate",
      };
    }
    case "pypi": {
      const files = body.urls || [];
      const sdist =
        files.find((file) => file.packagetype === "sdist" && !file.yanked) ||
        files.find((file) => !file.yanked);
      if (!sdist?.url) return null;
      return {
        url: sdist.url,
        sha256: sdist.digests?.sha256 || "",
        size: Number(sdist.size || 0),
        format: "tar.gz",
      };
    }
    case "rubygems":
      if (!body.gem_uri) return null;
      return {
        url: body.gem_uri,
        sha256: body.sha || "",
        size: 0,
        format: "gem",
      };
    case "hex": {
      const urls = nativeTarballUrls(host, name, version);
      return urls[0]
        ? { url: urls[0], sha256: "", size: 0, format: "tar" }
        : null;
    }
    case "pub-dev": {
      const latest = body.latest || body.versions?.find((row) => row.version === version);
      const archive = latest?.archive_url;
      return archive
        ? { url: archive, sha256: latest.archive_sha256 || "", size: 0, format: "tar.gz" }
        : null;
    }
    default: {
      const urls = nativeTarballUrls(host, name, version);
      return urls[0]
        ? { url: urls[0], sha256: "", size: 0, format: "tar.gz" }
        : null;
    }
  }
}

export function descriptionFromNativeBody(host, body) {
  if (!body || typeof body !== "object") return null;
  return (
    body.description ||
    body.crate?.description ||
    body.info?.summary ||
    body.meta?.description ||
    null
  );
}

export function toPackageMetadata(host, org, name, body) {
  const versions = versionsFromNativeBody(host, body);
  return {
    org,
    name,
    description: descriptionFromNativeBody(host, body),
    vcs: host.id === "crates-io" || host.id === "npm" ? "git" : "none",
    repo_url: repoUrlFromNative(host, name, body),
    latest: versions[0] || body.version || null,
    tags: [],
    versions,
    native_host: host.id,
  };
}

export function toVersionMetadata(host, org, name, version, body, download) {
  return {
    org,
    name,
    version,
    sha256: download?.sha256 || "",
    size: download?.size || 0,
    format: download?.format || "tar.gz",
    vcs_tag: version,
    vcs_commit: null,
    download_url: download?.url || "",
    published_at: body.time?.[version] || body.created_at || "1970-01-01T00:00:00Z",
    yanked: Boolean(body.yanked || body.retired),
    mirrors: download?.url
      ? [{ kind: `native-${host.id}`, url: download.url }]
      : [],
    native_host: host.id,
  };
}

function repoUrlFromNative(host, name, body) {
  const repo =
    body.repository?.url ||
    body.repository ||
    body.crate?.repository ||
    body.info?.project_urls?.Source ||
    body.source_code_uri ||
    null;
  if (typeof repo === "string" && repo.startsWith("http")) {
    return repo.replace(/^git\+/, "").replace(/\.git$/, "");
  }
  switch (host.id) {
    case "npm":
      return `https://www.npmjs.com/package/${name}`;
    case "crates-io":
      return `https://crates.io/crates/${name}`;
    case "pypi":
      return `https://pypi.org/project/${name}/`;
    case "rubygems":
      return `https://rubygems.org/gems/${name}`;
    default:
      return `https://${host.id}/${name}`;
  }
}

function integrityToSha256(integrity) {
  if (typeof integrity !== "string") return "";
  const match = integrity.match(/^sha256-([A-Za-z0-9+/=]+)$/);
  if (!match) return "";
  try {
    const bytes = Uint8Array.from(atob(match[1]), (c) => c.charCodeAt(0));
    return [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  } catch {
    return "";
  }
}

function sortVersionsDesc(a, b) {
  return a < b ? 1 : a > b ? -1 : 0;
}

export function statusMeansPrivateOrMissing(status) {
  return status === 401 || status === 403 || status === 404 || status === 451;
}
