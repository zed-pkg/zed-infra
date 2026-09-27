const ECOSYSTEM = /^[a-z0-9][a-z0-9-]{0,63}$/;
const SAFE_COMPONENT = /^[A-Za-z0-9][A-Za-z0-9._+@-]{0,191}$/;
const SAFE_MAVEN_GROUP = /^[A-Za-z0-9][A-Za-z0-9._-]{0,191}$/;

/**
 * Native registry catalog used by the Cloudflare fallback plane.
 *
 * This file is intentionally data-first. Adding a registry here does not by
 * itself authorize arbitrary outbound fetches: callers must still build URLs
 * from the canonical bases below and must validate redirects against the
 * per-registry allowlist. Credentials are never attached to public fallback
 * reads.
 */
export const NATIVE_REGISTRIES = Object.freeze({
  npm: registry("npm", ["npm", "npmjs", "npmjs.com"], ["registry.npmjs.org"], "npm"),
  "crates-io": registry("crates-io", ["crates-io", "crates.io", "cargo"], ["crates.io", "static.crates.io"], "cargo"),
  pypi: registry("pypi", ["pypi", "python", "pip", "poetry", "uv"], ["pypi.org", "files.pythonhosted.org"], "python"),
  maven: registry("maven", ["maven", "maven-central", "gradle", "sbt", "java", "kotlin", "scala"], ["repo1.maven.org", "search.maven.org"], "maven"),
  nuget: registry("nuget", ["nuget", "dotnet", "csharp", "fsharp"], ["api.nuget.org", "globalcdn.nuget.org"], "nuget"),
  packagist: registry("packagist", ["packagist", "composer", "php"], ["repo.packagist.org", "api.github.com", "github.com", "codeload.github.com"], "composer"),
  rubygems: registry("rubygems", ["rubygems", "gem", "bundler", "ruby"], ["rubygems.org"], "rubygems"),
  "go-proxy": registry("go-proxy", ["go", "golang", "go-proxy", "proxy.golang.org"], ["proxy.golang.org", "sum.golang.org"], "go"),
  hex: registry("hex", ["hex", "hexpm", "elixir", "erlang", "beam"], ["hex.pm", "repo.hex.pm"], "hex"),
  conan: registry("conan", ["conan", "conancenter", "cpp", "c++"], ["center2.conan.io"], "conan"),
  hackage: registry("hackage", ["hackage", "cabal", "stack", "haskell"], ["hackage.haskell.org"], "hackage"),
  clojars: registry("clojars", ["clojars", "clojure"], ["repo.clojars.org", "clojars.org"], "maven"),
  cpan: registry("cpan", ["cpan", "perl"], ["www.cpan.org", "cpan.metacpan.org", "fastapi.metacpan.org"], "cpan"),
  luarocks: registry("luarocks", ["luarocks", "lua"], ["luarocks.org"], "luarocks"),
  opam: registry("opam", ["opam", "ocaml"], ["opam.ocaml.org"], "opam"),
  julia: registry("julia", ["julia", "julia-general"], ["pkg.julialang.org", "github.com", "raw.githubusercontent.com"], "julia"),
  cran: registry("cran", ["cran", "r", "r-project"], ["cloud.r-project.org", "cran.r-project.org"], "cran"),
  "conda-forge": registry("conda-forge", ["conda", "conda-forge", "mamba"], ["conda.anaconda.org"], "conda"),
  cocoapods: registry("cocoapods", ["cocoapods", "pod", "swift", "objective-c"], ["cdn.cocoapods.org", "github.com", "raw.githubusercontent.com"], "cocoapods"),
  jsr: registry("jsr", ["jsr", "deno", "bun"], ["jsr.io"], "jsr"),
  terraform: registry("terraform", ["terraform", "terraform-registry", "opentofu", "tofu"], ["registry.terraform.io", "releases.hashicorp.com", "github.com", "objects.githubusercontent.com"], "terraform"),
  docker: registry("docker", ["docker", "docker-hub", "dockerhub", "oci"], ["registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com"], "oci"),
});

const ALIASES = new Map();
for (const entry of Object.values(NATIVE_REGISTRIES)) {
  for (const alias of entry.aliases) {
    ALIASES.set(normalizeEcosystem(alias), entry);
  }
}

function registry(id, aliases, hosts, coordinateKind) {
  return Object.freeze({
    id,
    aliases: Object.freeze(aliases),
    hosts: Object.freeze(hosts),
    coordinateKind,
  });
}

export function normalizeEcosystem(value) {
  if (typeof value !== "string") return "";
  const normalized = value.trim().toLowerCase().replace(/[_ .]+/g, "-");
  return ECOSYSTEM.test(normalized) ? normalized : "";
}

export function nativeRegistryFromOrg(org) {
  return ALIASES.get(normalizeEcosystem(org)) || null;
}

/**
 * Encode a native package coordinate into one Zed path-safe segment.
 *
 * We use base64url rather than ad-hoc slash replacement so Maven, Go, scoped
 * JS, Packagist, Terraform and OCI coordinates round-trip without ambiguity.
 * The `z1_` prefix prevents accidental collision with legacy plain names.
 */
export function encodeNativeCoordinate(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > 1024) return null;
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return `z1_${btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "")}`;
}

export function decodeNativeCoordinate(value) {
  if (typeof value !== "string" || !/^z1_[A-Za-z0-9_-]{1,2048}$/.test(value)) return null;
  const raw = value.slice(3).replace(/-/g, "+").replace(/_/g, "/");
  const padded = raw + "=".repeat((4 - (raw.length % 4)) % 4);
  try {
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (ch) => ch.charCodeAt(0));
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

/** Validate the decoded coordinate according to the upstream ecosystem. */
export function isValidNativeCoordinate(registryEntry, coordinate) {
  if (!registryEntry || typeof coordinate !== "string" || coordinate.length === 0 || coordinate.length > 1024) {
    return false;
  }
  if (/\0|\r|\n/.test(coordinate)) return false;

  switch (registryEntry.coordinateKind) {
    case "npm":
    case "jsr":
      return isJsLikeCoordinate(coordinate);
    case "maven":
      return isMavenCoordinate(coordinate);
    case "composer":
      return isSlashPair(coordinate);
    case "go":
      return isSlashPath(coordinate);
    case "terraform":
      return isTerraformCoordinate(coordinate);
    case "oci":
      return isOciCoordinate(coordinate);
    default:
      return SAFE_COMPONENT.test(coordinate) && !coordinate.includes("..") && !coordinate.includes("/") && !coordinate.includes("\\");
  }
}

export function decodeAndValidateNativeCoordinate(registryEntry, encodedOrLegacy) {
  const decoded = encodedOrLegacy?.startsWith?.("z1_") ? decodeNativeCoordinate(encodedOrLegacy) : encodedOrLegacy;
  if (!isValidNativeCoordinate(registryEntry, decoded)) return null;
  return decoded;
}

export function isAllowedNativeHost(registryEntry, rawUrl) {
  if (!registryEntry || typeof rawUrl !== "string") return false;
  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return false;
  }
  return (
    url.protocol === "https:" &&
    !url.username &&
    !url.password &&
    !url.port &&
    registryEntry.hosts.includes(url.hostname.toLowerCase())
  );
}

function isJsLikeCoordinate(value) {
  if (value.startsWith("@")) {
    const parts = value.split("/");
    return parts.length === 2 && /^@[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(parts[0]) && SAFE_COMPONENT.test(parts[1]);
  }
  return SAFE_COMPONENT.test(value) && !value.includes("/") && !value.includes("\\");
}

function isMavenCoordinate(value) {
  const parts = value.split(":");
  return parts.length === 2 && SAFE_MAVEN_GROUP.test(parts[0]) && SAFE_COMPONENT.test(parts[1]);
}

function isSlashPair(value) {
  const parts = value.split("/");
  return parts.length === 2 && parts.every((part) => SAFE_COMPONENT.test(part));
}

function isSlashPath(value) {
  if (value.includes("\\") || value.includes("..") || value.startsWith("/") || value.endsWith("/")) return false;
  const parts = value.split("/");
  return parts.length >= 2 && parts.length <= 32 && parts.every((part) => SAFE_COMPONENT.test(part));
}

function isTerraformCoordinate(value) {
  const parts = value.split("/");
  return (parts.length === 2 || parts.length === 3) && parts.every((part) => SAFE_COMPONENT.test(part));
}

function isOciCoordinate(value) {
  if (value.includes("\\") || value.includes("..") || value.startsWith("/") || value.endsWith("/")) return false;
  const parts = value.split("/");
  return parts.length >= 1 && parts.length <= 16 && parts.every((part) => /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(part));
}
