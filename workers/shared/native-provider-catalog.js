/**
 * Native registry capability contract shared by edge fallback code.
 *
 * The important distinction is not "supported / unsupported". Registries have
 * different wire shapes, coordinate grammars and publication semantics. The
 * edge can normalize a subset into Zed package metadata today; the remaining
 * registries are still first-class providers but require a protocol-preserving
 * gateway (or OCI/VCS handoff) rather than pretending every dependency is one
 * anonymous tarball.
 */

export const NATIVE_READ_MODE = Object.freeze({
  NORMALIZED: "normalized",
  PROTOCOL_GATEWAY: "protocol-gateway",
  OCI: "oci",
});

export const NATIVE_PUBLISH_MODE = Object.freeze({
  UPLOAD: "upload",
  MULTI_STEP: "multi-step",
  VCS: "vcs",
  MODERATED: "moderated",
  OCI: "oci",
});

function provider({
  id,
  aliases,
  read,
  publish,
  protocol,
  metadata,
  artifactHosts = [],
  coordinate = "name",
}) {
  return Object.freeze({
    id,
    aliases: Object.freeze(aliases),
    read,
    publish,
    protocol,
    metadata,
    artifactHosts: Object.freeze(artifactHosts),
    coordinate,
  });
}

export const NATIVE_PROVIDER_CATALOG = Object.freeze({
  npm: provider({
    id: "npm",
    aliases: ["npm", "npmjs", "npmjs.com"],
    read: NATIVE_READ_MODE.NORMALIZED,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "npm",
    metadata: "https://registry.npmjs.org",
    artifactHosts: ["registry.npmjs.org"],
  }),
  "crates-io": provider({
    id: "crates-io",
    aliases: ["crates-io", "crates.io", "cargo"],
    read: NATIVE_READ_MODE.NORMALIZED,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "cargo-sparse",
    metadata: "https://crates.io/api/v1",
    artifactHosts: ["crates.io", "static.crates.io"],
  }),
  pypi: provider({
    id: "pypi",
    aliases: ["pypi", "pypi.org", "python"],
    read: NATIVE_READ_MODE.NORMALIZED,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "pypi",
    metadata: "https://pypi.org/pypi",
    artifactHosts: ["files.pythonhosted.org"],
  }),
  "maven-central": provider({
    id: "maven-central",
    aliases: ["maven-central", "maven", "central", "sonatype"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.MULTI_STEP,
    protocol: "maven2",
    metadata: "https://repo.maven.apache.org/maven2",
    artifactHosts: ["repo.maven.apache.org", "repo1.maven.org"],
    coordinate: "group:artifact[:classifier]",
  }),
  nuget: provider({
    id: "nuget",
    aliases: ["nuget", "nuget.org"],
    read: NATIVE_READ_MODE.NORMALIZED,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "nuget-v3",
    metadata: "https://api.nuget.org/v3-flatcontainer",
    artifactHosts: ["api.nuget.org", "globalcdn.nuget.org"],
  }),
  packagist: provider({
    id: "packagist",
    aliases: ["packagist", "packagist.org", "composer"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.VCS,
    protocol: "composer-v2",
    metadata: "https://repo.packagist.org",
    artifactHosts: ["repo.packagist.org", "api.github.com", "codeload.github.com", "github.com"],
    coordinate: "vendor/name",
  }),
  rubygems: provider({
    id: "rubygems",
    aliases: ["rubygems", "rubygems.org", "gem"],
    read: NATIVE_READ_MODE.NORMALIZED,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "rubygems-api",
    metadata: "https://rubygems.org/api",
    artifactHosts: ["rubygems.org"],
  }),
  "go-proxy": provider({
    id: "go-proxy",
    aliases: ["go-proxy", "goproxy", "go-modules", "golang"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.VCS,
    protocol: "go-proxy",
    metadata: "https://proxy.golang.org",
    artifactHosts: ["proxy.golang.org"],
    coordinate: "module/path",
  }),
  hex: provider({
    id: "hex",
    aliases: ["hex", "hex.pm"],
    read: NATIVE_READ_MODE.NORMALIZED,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "hex-api",
    metadata: "https://hex.pm/api",
    artifactHosts: ["repo.hex.pm", "hex.pm"],
  }),
  "conan-center": provider({
    id: "conan-center",
    aliases: ["conan-center", "conancenter", "conan"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.VCS,
    protocol: "conan-v2",
    metadata: "https://center2.conan.io",
    artifactHosts: ["center2.conan.io", "center.conan.io"],
    coordinate: "name/version[:package-id]",
  }),
  hackage: provider({
    id: "hackage",
    aliases: ["hackage", "hackage.haskell.org", "cabal"],
    read: NATIVE_READ_MODE.NORMALIZED,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "hackage-api",
    metadata: "https://hackage.haskell.org/package",
    artifactHosts: ["hackage.haskell.org"],
  }),
  clojars: provider({
    id: "clojars",
    aliases: ["clojars", "clojars.org", "clojure"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "maven2",
    metadata: "https://repo.clojars.org",
    artifactHosts: ["repo.clojars.org"],
    coordinate: "group:artifact",
  }),
  cpan: provider({
    id: "cpan",
    aliases: ["cpan", "metacpan", "pause", "perl"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "cpan-pause",
    metadata: "https://fastapi.metacpan.org/v1",
    artifactHosts: ["cpan.metacpan.org", "fastapi.metacpan.org"],
    coordinate: "module-or-distribution",
  }),
  luarocks: provider({
    id: "luarocks",
    aliases: ["luarocks", "luarocks.org", "lua"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "luarocks",
    metadata: "https://luarocks.org",
    artifactHosts: ["luarocks.org"],
  }),
  opam: provider({
    id: "opam",
    aliases: ["opam", "opam.ocaml.org", "ocaml"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.MODERATED,
    protocol: "opam-repository",
    metadata: "https://opam.ocaml.org",
    artifactHosts: ["opam.ocaml.org", "github.com", "codeload.github.com"],
  }),
  "julia-general": provider({
    id: "julia-general",
    aliases: ["julia-general", "julia", "general"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.MODERATED,
    protocol: "julia-pkg",
    metadata: "https://pkg.julialang.org",
    artifactHosts: ["pkg.julialang.org"],
    coordinate: "uuid/tree-hash",
  }),
  cran: provider({
    id: "cran",
    aliases: ["cran", "cran.r-project.org", "r"],
    read: NATIVE_READ_MODE.NORMALIZED,
    publish: NATIVE_PUBLISH_MODE.MODERATED,
    protocol: "cran",
    metadata: "https://cran.r-project.org/src/contrib",
    artifactHosts: ["cran.r-project.org"],
  }),
  "conda-forge": provider({
    id: "conda-forge",
    aliases: ["conda-forge", "conda", "anaconda"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.MODERATED,
    protocol: "conda",
    metadata: "https://conda.anaconda.org/conda-forge",
    artifactHosts: ["conda.anaconda.org", "api.anaconda.org", "anaconda.org"],
    coordinate: "name+subdir+build",
  }),
  cocoapods: provider({
    id: "cocoapods",
    aliases: ["cocoapods", "cocoapods.org", "pods"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.UPLOAD,
    protocol: "cocoapods-trunk",
    metadata: "https://cdn.cocoapods.org",
    artifactHosts: ["cdn.cocoapods.org", "github.com", "codeload.github.com"],
  }),
  jsr: provider({
    id: "jsr",
    aliases: ["jsr", "jsr.io"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.MULTI_STEP,
    protocol: "jsr",
    metadata: "https://jsr.io",
    artifactHosts: ["jsr.io", "npm.jsr.io"],
    coordinate: "@scope/name",
  }),
  "terraform-registry": provider({
    id: "terraform-registry",
    aliases: ["terraform-registry", "terraform", "registry.terraform.io"],
    read: NATIVE_READ_MODE.PROTOCOL_GATEWAY,
    publish: NATIVE_PUBLISH_MODE.VCS,
    protocol: "terraform-registry",
    metadata: "https://registry.terraform.io",
    artifactHosts: ["registry.terraform.io", "releases.hashicorp.com", "github.com", "codeload.github.com"],
    coordinate: "namespace/name/provider-or-type",
  }),
  "docker-hub": provider({
    id: "docker-hub",
    aliases: ["docker-hub", "dockerhub", "docker.io", "oci"],
    read: NATIVE_READ_MODE.OCI,
    publish: NATIVE_PUBLISH_MODE.OCI,
    protocol: "oci-distribution-v2",
    metadata: "https://registry-1.docker.io",
    artifactHosts: ["registry-1.docker.io", "auth.docker.io", "production.cloudflare.docker.com"],
    coordinate: "namespace/image[:tag|@digest]",
  }),
});

const ALIAS_TO_PROVIDER = new Map();
for (const item of Object.values(NATIVE_PROVIDER_CATALOG)) {
  for (const alias of item.aliases) {
    ALIAS_TO_PROVIDER.set(alias, item);
  }
}

export function normalizeProviderToken(value) {
  if (typeof value !== "string") return "";
  return value.trim().toLowerCase().replace(/[_ ]/g, "-");
}

export function nativeProviderFromToken(value) {
  return ALIAS_TO_PROVIDER.get(normalizeProviderToken(value)) || null;
}

export function normalizedNativeProviders() {
  return Object.values(NATIVE_PROVIDER_CATALOG).filter(
    (item) => item.read === NATIVE_READ_MODE.NORMALIZED,
  );
}

export function nativeProviderIds() {
  return Object.keys(NATIVE_PROVIDER_CATALOG);
}
