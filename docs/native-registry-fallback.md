# Native registry fallback plane

The Zed registry edge is a degraded-mode dependency resolver, not an open package proxy. A native ecosystem can make edge network requests only after it has a protocol-specific adapter with bounded metadata parsing, exact coordinate validation, path-bound artifact validation, redirect confinement, and a truthful mapping into the shared artifact wire contract.

## Ordering

For package/version reads the edge uses this order:

1. Zed-published R2 metadata/artifacts.
2. An audited public native-registry adapter, when the request namespace identifies one.
3. The independently public GitHub fallback.
4. The canonical origin response when it was reachable but returned a miss.

`zed-cli` wraps its configured HTTP registry with `FallbackRegistry`, so a deployment pointed at `registry.zpkg.net` reaches the Cloudflare edge before the CLI attempts direct GitHub fallback.

## Registry catalog and activation

Catalog membership is not network authorization. The catalog supplies a stable ecosystem ID, aliases, coordinate grammar, and known upstream hosts. The production dispatcher separately controls which ecosystems may perform network reads.

There are currently **12 active adapters** and **10 catalog-only, fail-closed protocols**.

| Ecosystem | Edge read adapter | Degraded-mode contract |
| --- | --- | --- |
| npm | active | JSON metadata + scoped-name codec + exact `.tgz` path |
| crates.io | active | crates API + checksum + `.crate` mapped truthfully to `tar.gz` |
| PyPI | active | JSON API, sdist only, SHA-256 required, filename bound to metadata |
| Maven Central | active | Solr/GAV metadata + deterministic JAR path; JAR maps to `zip` |
| NuGet | active | v3 flat container + canonical version + `.nupkg` mapped to `zip` |
| Go Module Proxy | active | exact `@v/list` text parser, `.info` JSON, Go escaping, deterministic `.zip` |
| Hackage | active | package version map + exact `.tar.gz` |
| Clojars | active | artifact API + exact stable JAR path; snapshots fail closed |
| CPAN / MetaCPAN | active | exact version/release + SHA-256 + byte size + `authors/id` archive path |
| CRAN | active | exact per-package `DESCRIPTION`; current `src/contrib` source release only |
| JSR | active | official npm-compat registry + revision-bound immutable `.tgz` |
| Packagist | active | Composer p2 metadata + stable versions + repository/commit-bound GitHub ZIP |
| RubyGems | fail-closed | `.gem` needs truthful artifact/extraction support |
| Hex | fail-closed | native Hex release container semantics need artifact support |
| ConanCenter | fail-closed | recipe/package-ID protocol required |
| LuaRocks | fail-closed | rockspec/source protocol and parser required |
| OPAM | fail-closed | repository index/source mapping required |
| Julia General | fail-closed | registry tree/package-server semantics required |
| conda-forge | fail-closed | `.conda`/`.tar.bz2` need truthful artifact/extraction support |
| CocoaPods | fail-closed | podspec/source URL validation required |
| Terraform Registry | fail-closed | module/provider protocols are multi-step and providers are platform-specific |
| Docker Hub | fail-closed | OCI bearer challenge, manifest/index and blob graph semantics required |

Adding a hostname to the catalog never makes that hostname reachable from user-controlled coordinates.

## Active protocol invariants

### Go Module Proxy

- package discovery uses bounded `text/plain` only on exact HTTPS `proxy.golang.org/.../@v/list` URLs;
- exact versions use `$module/@v/$version.info` JSON;
- module paths and versions apply Go uppercase escaping (`A` -> `!a`);
- downloads use exact `$module/@v/$version.zip` paths;
- ZIPs are edge-hashed under the degraded-mode artifact size bound.

### Clojars

- coordinates are explicit `<group>:<artifact>` values transported with the reversible `z1_` codec;
- metadata comes only from `https://clojars.org/api/artifacts/<group>/<artifact>`;
- returned `group_name`/`jar_name` must match the request;
- `-SNAPSHOT` versions are excluded;
- stable downloads are exactly `https://repo.clojars.org/<group path>/<artifact>/<version>/<artifact>-<version>.jar`.

### CPAN / MetaCPAN

- exact-version metadata uses MetaCPAN `download_url` and must identify the requested version;
- release identity must be `<distribution>-<version>`;
- artifact URL must be an exact HTTPS `cpan.metacpan.org/authors/id/.../<distribution>-<version>.tar.gz` path;
- MetaCPAN must supply lowercase SHA-256 and positive byte size.

### CRAN

- metadata is fetched only from exact `https://cran.r-project.org/web/packages/<package>/DESCRIPTION`;
- the text parser is enabled only for that exact host/path/content-type family;
- only validated DESCRIPTION fields are retained;
- current source artifact is exactly `https://cran.r-project.org/src/contrib/<package>_<version>.tar.gz`;
- historical archive lookup remains fail-closed.

### Packagist

- metadata is fetched only from `https://repo.packagist.org/p2/<vendor>/<package>.json`;
- the metadata package key must exactly match the requested coordinate;
- dev branches are not eligible for degraded resolution;
- accepted GitHub distributions must carry immutable source/dist references;
- the adapter rewrites the accepted distribution to exact `https://codeload.github.com/<owner>/<repo>/zip/<commit>` form;
- owner, repository and commit are carried in the candidate validation context and rechecked before download;
- generic `github.com` or `api.github.com` catalog membership never authorizes an arbitrary download URL.

## Security invariants

Public fallback reads are anonymous and fail closed:

- HTTPS only;
- no URL userinfo or explicit ports;
- exact hostname allowlists, never suffix or wildcard matching;
- ecosystem-specific coordinate validation;
- reversible `z1_` base64url transport for scoped or multi-segment coordinates;
- bounded metadata bodies and content-type checks;
- non-JSON parsers only on exact protocol-specific host/path/content-type surfaces;
- redirects manually revalidated at every hop;
- protocol-specific artifact paths, not merely host checks;
- upstream SHA-256/size required when the native protocol supplies them;
- otherwise artifact bytes are bounded and SHA-256 is established at the edge before metadata is returned;
- malformed, private, unpublished, wrong-package, wrong-version and cross-repository responses authorize nothing.

## Artifact-format boundary

The current authoritative Rust `ArtifactFormat` exposes only `tar.gz` and `zip`. An adapter may activate only when its install artifact maps truthfully to one of those formats, or after the shared interface and extraction stack are expanded first.

That permits Maven/Clojars JARs, NuGet packages, Go module ZIPs and Packagist GitHub distributions to map to `zip`, and crates.io/Hackage/JSR/CPAN/CRAN archives to map to `tar.gz`. RubyGems `.gem`, native Hex containers, conda `.conda`/`.tar.bz2`, and OCI manifest/layer graphs remain fail-closed. The edge must never relabel an incompatible native container merely to pass deserialization.

## Independent CI witness

Source-org Actions budget is not proof of correctness. `zed-pkg-test/security-adversarial-e2e#19` provides an independent public witness with its own Actions budget.

The witness:

1. checks out an exact `zed-infra` commit SHA;
2. asserts the exact SHA before tests;
3. installs the locked Worker dependencies;
4. runs `npm audit --audit-level=low`;
5. runs catalog, security, wire-contract, production-dispatcher and protocol-specific tests in the fast job;
6. runs the complete Worker suite independently with a longer timeout.

A source-repository cancellation due to Actions minutes is not interpreted as a failing assertion. A witness timeout is reported as a timeout, not a failed registry assertion. Any actual test assertion failure remains a blocker. The witness SHA must be advanced whenever PR 108 changes before its green result can be used as evidence.

## Publish boundary

Native-registry publishing is not a transparent outage retry. Zed-owned artifacts may use the existing R2/GHCR degraded publish path, but publishing into npm, crates.io, PyPI, Maven, NuGet, Packagist or another native provider is a distinct capability with provider-specific formats, credentials, namespace ownership, immutability and provenance semantics.

Any future native multi-publish flow must be explicit, provider-scoped, idempotent and credential-brokered. Before a write it must check the target version and provenance; an existing version with different bytes or provenance fails closed.

## Adding another active adapter

Before promotion from catalog-only to production-active, require tests for:

1. canonical package metadata URL;
2. canonical exact-version URL or documented package-metadata reuse;
3. coordinate/traversal validation;
4. public/private/missing behavior;
5. exact artifact path binding;
6. redirect confinement;
7. metadata size/content-type bounds;
8. artifact size bounds;
9. trusted digest source or bounded edge hashing;
10. truthful `ArtifactFormat`/`VersionMetadata` mapping;
11. malformed/wrong-package/wrong-version negatives;
12. registry-proxy integration preserving R2 -> native -> GitHub ordering;
13. an independent test-org run pinned to the exact source SHA.
