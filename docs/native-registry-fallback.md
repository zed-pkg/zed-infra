# Native registry fallback plane

The Zed registry edge is a degraded-mode dependency resolver, not an open package proxy.
When the canonical Zed origin is unavailable, a public package lookup may be answered from a native ecosystem only when the ecosystem has a protocol-specific adapter whose metadata, artifact path, redirects, size, and digest behavior are explicitly validated.

## Ordering

For package/version reads the edge uses this order:

1. Zed-published R2 metadata/artifacts.
2. An audited public native-registry adapter, when the request namespace identifies one.
3. The independently public GitHub fallback.
4. The canonical origin response when it was reachable but returned a miss.

`zed-cli` already wraps the configured HTTP registry with its direct source fallback, so a deployment that points the CLI at `registry.zpkg.net` reaches the Cloudflare edge before the CLI attempts its own direct GitHub fallback.

## Registry catalog and activation

Catalog membership is not network authorization. The catalog gives Zed a stable ecosystem ID, aliases, coordinate grammar, and exact upstream host set. A separate active-adapter table controls which ecosystems can actually perform fallback network reads.

| Ecosystem | Catalog | Edge read adapter | Notes |
| --- | --- | --- | --- |
| npm | yes | active | JSON metadata + `.tgz`; scoped names use encoded coordinates |
| crates.io | yes | active | crates API + checksum + `.crate` mapped to `tar.gz` wire format |
| PyPI | yes | active | JSON API; sdist only; SHA-256 required |
| NuGet | yes | active | v3 flat container; `.nupkg` mapped to `zip` |
| Maven Central | yes | fail-closed | Maven coordinate/POM/JAR protocol still needs dedicated adapter |
| Packagist | yes | fail-closed | Dist/source URLs require repository-bound GitHub/CDN validation |
| RubyGems | yes | fail-closed | `.gem` container semantics need an explicit artifact contract |
| Go Module Proxy | yes | fail-closed | module path escaping and `.info/.mod/.zip` protocol required |
| Hex | yes | fail-closed | release metadata/tarball semantics need dedicated adapter |
| ConanCenter | yes | fail-closed | recipe/package-ID protocol required |
| Hackage | yes | fail-closed | package index and tarball protocol required |
| Clojars | yes | fail-closed | Maven-compatible coordinate/artifact adapter required |
| CPAN | yes | fail-closed | author/distribution metadata mapping required |
| LuaRocks | yes | fail-closed | rockspec/source archive mapping required |
| OPAM | yes | fail-closed | repository index/source mapping required |
| Julia General | yes | fail-closed | registry tree/package-server semantics required |
| CRAN | yes | fail-closed | current/archive package index mapping required |
| conda-forge | yes | fail-closed | `.conda`/`.tar.bz2` artifact contract required |
| CocoaPods | yes | fail-closed | spec/source URL validation required |
| JSR | yes | fail-closed | JSR metadata/artifact protocol required |
| Terraform Registry | yes | fail-closed | provider/module variants and platform checks required |
| Docker Hub | yes | fail-closed | OCI bearer challenge, manifests, blobs and digest semantics required |

The fail-closed entries are intentional. Adding an upstream hostname to the catalog must never make that hostname reachable from user-controlled package coordinates.

## Security invariants

Public fallback reads follow these rules:

- anonymous only; provider credentials are never attached to public registry reads;
- HTTPS only;
- no URL userinfo and no explicit ports;
- exact hostname allowlists, never suffix or wildcard matching;
- package coordinates are validated per ecosystem;
- multi-segment/scoped coordinates are transported as reversible `z1_` base64url path segments;
- metadata bodies are content-type checked and size bounded;
- redirects are manual and revalidated at every hop;
- artifact paths are protocol-specific, not merely host-specific;
- artifacts with no trusted upstream SHA-256 are bounded and hashed at the edge before metadata is returned;
- invalid/private/unpublished responses do not reveal upstream internals and do not authorize alternate URLs;
- unsupported protocols return no native fallback and continue to the independent GitHub path.

## Publish boundary

Native-registry publishing is not a transparent outage retry.

A Zed publish can use the existing R2/GHCR degraded path because the artifact and metadata remain Zed-owned contracts. Publishing to PyPI, Maven Central, NuGet, npm, crates.io, or another native registry is a separate capability: each provider has native package formats, namespace ownership, credentials, immutability rules, provenance requirements, and provider-specific APIs.

Any future native multi-publish flow must therefore be explicit, provider-scoped, idempotent, and credential-brokered. Before a write it must check the target version and provenance; an existing version with different bytes or provenance must fail closed rather than overwrite or reinterpret the package.

## Adding another active adapter

Before moving an ecosystem from fail-closed to active, add tests for all of the following:

1. canonical package metadata URL;
2. canonical exact-version metadata URL;
3. package-coordinate validation, including traversal and encoded-path negatives;
4. anonymous/public proof and private/missing responses;
5. exact artifact URL/path binding;
6. redirect allowlist behavior;
7. metadata size/content-type bounds;
8. artifact size bound;
9. digest source or edge hashing path;
10. mapping into the existing Rust `ArtifactFormat` and `VersionMetadata` wire contract;
11. malformed metadata and wrong-package/wrong-version negative cases;
12. integration through the registry proxy without bypassing R2-first/GitHub-last ordering.
