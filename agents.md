# Agent instructions

## Scope and hierarchy

- These instructions apply to the whole `zed-pkg/zed-infra` repository unless a deeper lowercase `agents.md` adds narrower rules.
- Before editing, resolve the current working directory and load every readable ancestor `agents.md` from the filesystem root to the working directory. Do not search siblings. Resolve symlinks, deduplicate resolved files, and report unreadable or cyclic instruction files.
- `.claude/CLAUDE.md`, `.gemini/GEMINI.md`, and `.openai/AGENTS.md` are pointers only. Never duplicate instructions in tool-specific files.

## Repository role

This repository owns Zed infrastructure and deployment wiring: Terraform, Kubernetes, GitOps/app-of-apps configuration, environments, image/chart references, observability, and operational runbooks.

## Working rules

- Separate planning from mutation. Review plans/diffs and blast radius before any apply, sync, migration, deletion, or credential rotation.
- Keep environments explicit; never make production the implicit default and never reuse production state, namespaces, buckets, or credentials in tests.
- Pin images, charts, actions, providers, modules, and external manifests to reviewed versions or immutable digests.
- Preserve least privilege, network boundaries, resource limits, disruption budgets, readiness, rollback, backup, and restore behavior.
- Store only secret references and schemas in Git. Never commit plaintext secrets, kubeconfigs, state files, cloud credentials, private keys, or production environment files.
- Keep generated manifests reproducible and reviewable; do not hand-edit generated output without updating its source.
- Validate Terraform, Kubernetes schemas, policy checks, rendered diffs, dependency pins, and documented rollback procedures before review.
- Coordinate service/interface changes with deployment ordering and monorepo release-set pins.

## Validation

The pinned `agents policy` workflow validates this hierarchy and the three tool pointers. Follow `README.md`, environment runbooks, and existing CI for infrastructure-specific validation before requesting review.
