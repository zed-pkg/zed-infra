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

## Repository-local Git worktrees

- Create or use a Git worktree only when the human operator explicitly authorizes it for the current task. Concurrency or a dirty checkout is not permission by itself.
- Put every authorized worktree at `<repository-root>/tmp/worktrees/<name>`; from the repository root, use `./tmp/worktrees/<name>`. Never place worktrees beside repositories or organization directories.
- Keep `tmp`, `temp`, `tmp/worktrees`, and `temp/worktrees` ignored in the repository-root `.gitignore`. Do not commit files from those directories.
- Relocate or remove a worktree only when the operator explicitly requests it. Before removal, preserve and publish intended changes, verify its commit is represented on the target branch, and confirm there are no tracked, untracked, ignored-sensitive, or in-use files that must survive. Remove it with `git worktree remove <path>` without `--force`; never delete a worktree directory with `rm`.
