# Secure package intake, rebuild verification, and approval pipeline

Related work:

- `zed-pkg/zed-interfaces#153` — package risk-assessment evidence contract
- `zed-pkg/zed-infra#91` — hermetic policy-governed build environments
- `zed-pkg/zed-infra#92` — rebuild artifacts from immutable source
- `zed-pkg/zed-api-server.rs#114` — governed intake/quarantine/approval state machine

This document defines the infrastructure pipeline joining those pieces. It deliberately does not redefine the independent TypeSpec/JSON Schema authorities owned by `zed-interfaces`.

## Trust boundary

A package upload, VCS reference, package manifest, lifecycle script, AI-origin marker, maintainer claim, or caller-supplied risk field is untrusted input. Publication authority comes from admitted server policy plus immutable evidence produced by trusted scanners/builders/rebuilders and explicit approvers where policy requires them.

No scanner outage, policy outage, rebuild failure, or missing evidence may silently degrade to publish for a lane that requires that evidence.

## Pipeline

```text
submission
  -> source acquisition
  -> immutable source identity
  -> static/risk analysis
  -> hermetic build
  -> independent rebuild verification
  -> policy decision
  -> quarantine | approval | rejection | publish
```

Every stage consumes content-addressed inputs and emits a bounded receipt. A changed source tree, dependency graph, toolchain, build policy, or artifact digest invalidates evidence tied to the previous identity.

## 1. Source acquisition

Resolve mutable ecosystem coordinates before trusted execution:

- Git branches/tags resolve to immutable commit ids;
- submodules and nested dependency references resolve recursively;
- npm/Python/Cargo source archives retain upstream digest/signature/provenance evidence;
- private source credentials are scoped to acquisition and are not forwarded into the build sandbox;
- dependency manifests and lockfiles are retained by digest;
- dependency-confusion resolution records registry/namespace origin explicitly.

A mutable branch or tag is never sufficient publication identity.

## 2. Hermetic intake environment

Untrusted install/build/test hooks execute in an ephemeral least-privilege sandbox.

Default-denied capabilities:

- host home directory;
- host credential stores;
- cloud instance/workload credentials;
- arbitrary filesystem writes outside declared workspace/output mounts;
- arbitrary network egress;
- privileged containers/device access;
- undeclared process or namespace capabilities.

Explicit policy grants may allow bounded network endpoints, package mirrors, compiler/toolchain images, source mounts, cache mounts, CPU/memory/disk/time budgets, and output paths.

The base image/toolchain is pinned by immutable digest. `ores-compose` may reproduce the same service topology locally, but a developer machine is never the trust anchor for publication evidence.

## 3. AI-generated and malicious-package risk evidence

Risk detection is multi-signal evidence, not one model score. Adapters may contribute:

- namespace/typosquatting similarity;
- dependency-graph novelty or confusion risk;
- new install/postinstall/build hooks;
- process/network/filesystem capability requests;
- obfuscation, packed payloads, suspicious entropy, generated-code indicators;
- static malware findings;
- provenance/signature anomalies;
- source/artifact mismatch;
- maintainer/account/package-lineage signals supplied by trusted services;
- deterministic rebuild failure;
- model-assisted findings identified separately from deterministic rules.

AI-assisted origin can be retained as provenance when known, but security policy must not depend on self-reporting. Human-authored and machine-authored packages pass through the same mandatory isolation and evidence boundaries.

## 4. Rebuild from immutable source

For ecosystems where source-to-artifact rebuilding is meaningful:

1. acquire exact immutable source;
2. restore the admitted dependency graph and toolchain;
3. perform any allowlisted fetch phase;
4. disable network for the build/rebuild phase unless a declared content-addressed source is required;
5. rebuild in a fresh sandbox;
6. normalize only documented nondeterministic metadata;
7. compare output digests/structured artifacts;
8. emit reproducible, non-reproducible, or unsupported with typed reasons.

Initial adapters should cover npm, Cargo, Python wheel/sdist, and Git-backed Zed packages. Ecosystem-specific acquisition/build adapters remain separate from the provider-neutral rebuild verdict.

Sensitive package classes can require two independent builders or two infrastructure domains before promotion.

## 5. Intake policy and quarantine

The API-side state machine should consume exact artifact/source identity plus trusted evidence and produce immutable transitions such as:

```text
submitted -> scanning -> quarantined | pending_approval | approved | rejected -> published
```

Policy can require:

- no high-severity deterministic finding;
- minimum provenance/signature level;
- successful source rebuild;
- N-of-M human approval;
- designated package/org approver roles;
- a fresh assessment under the current policy version;
- stricter treatment for new packages, ownership changes, lifecycle scripts, native binaries, or sensitive namespaces.

An approval binds the exact source/artifact digest and policy decision. New bytes require a new decision/review. Approval history is append-only; revocation is another explicit transition rather than history mutation.

## 6. Storage and publication separation

Quarantine artifacts and published artifacts should not share an implicitly trusted prefix/bucket/path.

Recommended boundaries:

- source acquisition cache: content-addressed, non-public;
- untrusted submission artifacts: quarantine-only;
- scanner/build intermediate outputs: non-public, short retention;
- rebuild evidence/receipts: immutable evidence storage;
- published package objects: promoted only after the final admitted transition;
- public CDN/R2 origins read only from the published namespace.

Promotion copies or atomically references an exact admitted digest; it never rebuilds or mutates the artifact during publication.

## 7. Receipt model

Infrastructure receipts should reference, not redefine, the canonical Zed interface contracts. At minimum the pipeline needs stable references for:

- submission/package/version id;
- exact source identity/digest;
- dependency graph/lock digest;
- toolchain/base environment digest;
- sandbox capability-policy digest;
- scanner/rule/model revisions;
- build artifact digest;
- independent rebuild digest/verdict;
- policy version/decision id;
- approval transition ids where required;
- promotion/published-object digest.

Receipts exclude bearer tokens, SSH/private keys, source credentials, secret values, private package bodies, raw environment values, and unbounded model explanations.

## 8. Network and secret handling

Use distinct identities for acquisition, build, scan, rebuild, evidence write, and publication promotion. No single package-build identity should have both arbitrary source-controlled code execution and write access to the published registry namespace.

Where external credentials are unavoidable, bind them to a narrow phase and endpoint and revoke/expire them independently. Private package source credentials must not be visible to lifecycle scripts after acquisition.

## 9. CI and rollout

Infrastructure changes are plan/review only in PRs. Do not perform unattended production applies from this documentation branch.

Delivery slices:

1. **sandbox baseline** — ephemeral Linux worker, no ambient credentials, resource limits, default-deny egress;
2. **capability policy** — explicit network/filesystem/process/toolchain grants plus receipts;
3. **rebuild workers** — npm/Cargo/Python/Git adapters and deterministic comparison;
4. **risk-evidence ingestion** — consume the future `zed-interfaces` package-risk contract;
5. **quarantine storage** — separate prefixes/identities and lifecycle policy;
6. **API transition integration** — consume `zed-api-server.rs` intake decisions;
7. **promotion worker** — digest-preserving publish operation with least privilege;
8. **cross-ecosystem conformance** — malicious lifecycle hooks, dependency confusion, typosquatting, tag retargeting, source/artifact mismatch, nondeterministic build, stale approval, and policy/scanner outage fixtures.

## Acceptance invariants

- untrusted code never receives registry-publish credentials;
- mutable source coordinates are resolved before execution;
- package bytes cannot change without invalidating assessment/rebuild/approval evidence;
- required evidence failure never becomes implicit allow;
- publication is a distinct least-privilege promotion phase;
- private credentials are phase-scoped and absent from ordinary receipts/logs;
- infrastructure remains environment-explicit and production is never the default;
- all images/actions/providers/toolchains used for evidence are pinned to reviewed versions or immutable digests.
