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

There are currently **11 active adapters** and **11 catalog-only, fail-closed protocols**.

| Ecosystem | Catalog | Edge read adapter | Notes |
| --- | --- | --- | --- |
| npm | yes | active | JSON metadata + `.tgz`; scoped names use encoded coordinates |
| crates.io | yes | active | crates API + checksum + `.crate` mapped to `tar.gz` wire format |
| PyPI | yes | active | JSON API; sdist only; SHA-256 required and filename bound to metadata |
| Maven Central | yes | active | Solr/GAV metadata + deterministic JAR path; JAR maps to `zip` and is edge-hashed when SHA-256 is absent |
| NuGet | yes | active | v3 flat container; canonical index version + `.nupkg` mapped to `zip` |
| Go Module Proxy | yes | active | exact `@v/list` text parser, `.info` JSON, official `!lowercase` path/version escaping, deterministic `.zip`; bounded edge hashing |
| Hackage | yes | active | package JSON version map + canonical `.tar.gz`; artifact is edge-hashed |
| Clojars | yes | active | public artifact JSON + deterministic Maven JAR path for stable releases; snapshots stay fail-closed; JAR maps to `zip` and is edge-hashed |
| CPAN / MetaCPAN | yes | active | exact distribution/version lookup; release name, SHA-256, positive byte size and `authors/id` archive path are all bound before accepting `.tar.gz` |
| CRAN | yes | active | exact per-package `DESCRIPTION` parser; current source release only via deterministic `src/contrib/<package>_<version>.tar.gz`; bounded edge hashing |
| JSR | yes | active | official npm-compatibility registry; scoped JSR packages map to revision-bound immutable `.tgz` artifacts |
| Packagist | yes | fail-closed | Composer metadata minification and repository-bound GitHub/CDN dist validation still required |
| RubyGems | yes | fail-closed | `.gem` container semantics need an explicit artifact contract |
| Hex | yes | fail-closed | release metadata/tarball semantics need dedicated artifact-format support |
| ConanCenter | yes | fail-closed | recipe/package-ID protocol required |
| LuaRocks | yes | fail-closed | rockspec/source archive mapping required |
| OPAM | yes | fail-closed | repository index/source mapping required |
| Julia General | yes | fail-closed | registry tree/package-server semantics required |
| conda-forge | yes | fail-closed | `.conda`/`.tar.bz2` artifact contract required |
| CocoaPods | yes | fail-closed | spec/source URL validation required |
| Terraform Registry | yes | fail-closed | module download uses `X-Terraform-Get`; providers are platform-specific |
| Docker Hub | yes | fail-closed | OCI bearer challenge, manifests, blobs and multi-layer digest semantics required |

The fail-closed entries are intentional. Adding an upstream hostname to the catalog must never make that hostname reachable from user-controlled package coordinates.

## Go proxy degraded-mode limits

The Go module proxy adapter follows the public GOPROXY wire protocol rather than treating Go as an npm-like registry:

- package discovery uses the bounded `text/plain` `$module/@v/list` endpoint;
- the text parser is enabled only when the response URL is exact HTTPS `proxy.golang.org`, has no userinfo, port, query, or fragment, and ends in `/@v/list`;
- exact-version metadata uses `$module/@v/$version.info` JSON and must identify the requested version exactly;
- module paths and versions use Go's official uppercase escaping (`A` becomes `!a`);
- downloads use the deterministic `$module/@v/$version.zip` path and remain pinned to the same module/version;
- the ZIP is mapped truthfully to Zed's `zip` wire format and SHA-256 is computed at the edge when the native proxy does not supply one.

The edge hashing path intentionally keeps Zed's existing 32 MiB degraded-mode artifact bound. The public Go module protocol can represent larger modules, so this fallback is deliberately a bounded emergency path rather than a claim of complete GOPROXY equivalence.

## Clojars degraded-mode limits

The Clojars adapter uses the public artifact API and the canonical Maven repository instead of assuming every Maven-shaped coordinate is available from Maven Central.

- coordinates are explicit Maven-style `<group>:<artifact>` values transported through the reversible Zed coordinate codec;
- metadata is fetched only from `https://clojars.org/api/artifacts/<group>/<artifact>` and the returned `group_name` and `jar_name` must match the requested identity;
- only versions explicitly listed by the artifact API are eligible;
- `-SNAPSHOT` versions are excluded because Maven snapshot repositories may use timestamped filenames and a deterministic `<artifact>-<version>.jar` must not be guessed;
- stable artifacts are confined to the exact path `https://repo.clojars.org/<group path>/<artifact>/<version>/<artifact>-<version>.jar`;
- JARs map truthfully to Zed's `zip` wire format and use the existing bounded edge SHA-256 path when Clojars metadata does not supply a trusted SHA-256;
- an HTTPS SCM URL may be exposed as descriptive repository metadata, but it never authorizes artifact downloads from that SCM host.

## CPAN / MetaCPAN degraded-mode limits

The CPAN adapter uses the MetaCPAN `download_url` metadata endpoint rather than turning the CPAN mirror tree into a generic file proxy.

- package lookup returns the distribution selected by MetaCPAN; degraded package metadata therefore represents the current selected release rather than a complete historical index;
- exact-version lookup includes the requested version in the MetaCPAN query and accepts only a metadata response that identifies that same version;
- the release identity must be exactly `<distribution>-<version>`;
- the artifact must be an HTTPS `cpan.metacpan.org/authors/id/.../<distribution>-<version>.tar.gz` URL with no userinfo, explicit port, query or fragment;
- MetaCPAN must supply a lowercase SHA-256 and a positive integer artifact byte size before the candidate is trusted;
- because digest and byte size are both upstream-bound, the edge does not silently downgrade a known CPAN digest into an unverified alternate path.

## CRAN degraded-mode limits

CRAN intentionally uses a narrow current-release path instead of parsing the global `PACKAGES` index or guessing archive history.

- metadata is fetched only from exact HTTPS `cran.r-project.org/web/packages/<package>/DESCRIPTION`;
- the non-JSON parser is enabled only for `text/plain` responses from that exact URL shape;
- only a small whitelist of DESCRIPTION fields is retained, and package/version syntax is validated before use;
- the accepted source artifact is exactly `https://cran.r-project.org/src/contrib/<package>_<version>.tar.gz`;
- because `DESCRIPTION` describes the current package page, a request for a historical version fails closed rather than walking `src/contrib/Archive` without a separate audited archive protocol;
- CRAN does not supply the SHA-256 in this metadata path, so the existing bounded edge hashing path establishes transport SHA-256 and compressed size before returning version metadata.

## Security invariants

Public fallback reads follow these rules:

- anonymous only; provider credentials are never attached to public registry reads;
- HTTPS only;
- no URL userinfo and no explicit ports;
- exact hostname allowlists, never suffix or wildcard matching;
- package coordinates are validated per ecosystem;
- multi-segment/scoped coordinates are transported as reversible `z1_` base64url path segments;
- metadata bodies are content-type checked and size bounded;
- any non-JSON parser is enabled only for the exact registry host/path/content-type that requires it;
- redirects are manual and revalidated at every hop;
- artifact paths are protocol-specific, not merely host-specific;
- artifacts with no trusted upstream SHA-256 are bounded and hashed at the edge before metadata is returned;
- invalid/private/unpublished responses do not reveal upstream internals and do not authorize alternate URLs;
- unsupported protocols return no native fallback and continue to the independent GitHub path.

## Artifact-format boundary

The current Rust `ArtifactFormat` wire contract exposes `tar.gz` and `zip`. An adapter may activate only when its install artifact maps truthfully to one of those formats or when the wire contract is expanded first.

That is why Maven Central and Clojars JARs, NuGet packages, and Go module ZIPs can be represented as `zip`, and crates.io, Hackage, JSR, CPAN and CRAN source archives can be represented as `tar.gz`, while RubyGems `.gem`, Hex package containers, conda `.conda`/`.tar.bz2`, and OCI manifests/layers remain fail-closed. The edge must not relabel an incompatible package solely to make it pass deserialization.

## Independent CI witness

The source repository's Actions budget is not treated as proof of correctness. The native-registry fallback branch is also exercised from `zed-pkg-test/security-adversarial-e2e`, a public test-organization repository with an independent GitHub Actions budget. The witness checks out an exact zed-infra commit SHA and asserts that checkout before testing. Its fast job audits the locked Worker dependencies and runs the native-registry catalog, security, wire-contract, preserved-core, production-dispatcher, and protocol-adapter tests independently from the longer full Worker suite.

A source-repository cancellation caused by Actions-minute exhaustion is therefore not interpreted as a test failure. Conversely, an actual failing assertion in either repository remains a real blocker. The exact source SHA in the witness must be advanced whenever PR 108 changes before its green result can be used as merge evidence.

## Publish boundary

Native-registry publishing is not a transparent outage retry.

A Zed publish can use the existing R2/GHCR degraded path because the artifact and metadata remain Zed-owned contracts. Publishing to PyPI, Maven Central, NuGet, npm, crates.io, or another native registry is a separate capability: each provider has native package formats, namespace ownership, credentials, immutability rules, provenance requirements, and provider-specific APIs.

Any future native multi-publish flow must therefore be explicit, provider-scoped, idempotent, and credential-brokered. Before a write it must check the target version and provenance; an existing version with different bytes or provenance must fail closed rather than overwrite or reinterpret the package.

## Adding another active adapter

Before moving an ecosystem from fail-closed to active, add tests for all of the following:

1. canonical package metadata URL;
2. canonical exact-version metadata URL, or documented package-metadata reuse when the native protocol has no separate version endpoint;
3. package-coordinate validation, including traversal and encoded-path negatives;
4. anonymous/public proof and private/missing responses;
5. exact artifact URL/path binding;
6. redirect allowlist behavior;
7. metadata size/content-type bounds;
8. artifact size bound;
9. digest source or edge hashing path;
10. truthful mapping into the existing Rust `ArtifactFormat` and `VersionMetadata` wire contract;
11. malformed metadata and wrong-package/wrong-version negative cases;
12. integration through the registry proxy without bypassing R2-first/GitHub-last ordering;
13. an independent test-org Actions run pinned to the exact source SHA so source-org minute exhaustion cannot create a false negative.
