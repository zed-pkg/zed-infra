# Infrastructure monorepo layout

This repository may use reusable infrastructure under `modules/`, but provider Git sync must always terminate at a provider-native entrypoint. A provider must never be expected to discover `modules/` by ORESoftware convention alone.

## Canonical shape

```text
.
├── .ores-infra.toml
├── cloudflare/ or workers/       # Cloudflare sync roots; each Worker root contains Wrangler config
├── supabase/                     # Supabase-native tree when the integration working directory is `.`
│   ├── config.toml
│   ├── migrations/
│   └── functions/
├── neon.ts                       # Neon config-as-code entrypoint for the linked project root
├── modules/
│   ├── cloudflare/
│   ├── supabase/
│   └── neon/
└── environments/
    ├── dev/
    ├── staging/
    └── production/
```

The provider-facing files are adapters, not a competing authority. They may import or invoke reusable implementation under `modules/`. If the provider format cannot import modules directly, keep its deployable native tree in the provider-required location and put only reusable helpers/templates in `modules/`.

## Supabase

Supabase GitHub integration uses a **working directory**, and that directory must contain the `supabase/` child directory. Prefer `working directory = .` plus a root `supabase/` tree for the lowest-friction sync. If a repository has multiple Supabase project targets, each target may use a separate nested working directory, but each working directory still owns its own `supabase/` child. Do not point Supabase at `modules/supabase` unless that directory is itself intentionally the provider working directory and contains a child `supabase/` tree.

Changes under reusable Supabase modules must be reflected through the committed provider-native tree before promotion. Schema provisioning precedes application migrations; migrations precede edge/routing promotion.

## Cloudflare

Each connected Worker uses the directory containing its `wrangler.jsonc`, `wrangler.json`, or `wrangler.toml` as its Cloudflare Workers Builds **Root directory**. A single-Worker repo may use the repository root. A multi-Worker infra repo should use explicit roots such as `workers/<worker>/` or `cloudflare/<worker>/`.

When a Worker imports shared implementation from `modules/cloudflare/`, its build watch paths must include both the Worker sync root and the relevant module paths. The Worker name in the Wrangler config must continue to match the Cloudflare project connected to that root.

## Neon

Use a root `neon.ts` as the provider-facing config-as-code entrypoint for a linked Neon project. The root file may import reusable policy from `modules/neon/`. Local `.neon` link context is machine-local and must not become the fleet source of truth; CI or operators select the intended project/branch through the Neon CLI and approved environment boundary.

## Environments, state, and blast radius

`modules/` contains reusable implementation and should not own a single fleet-wide state file. Deploy roots and environment roots own independent remote state keys. A change in one provider root must be plannable without requiring unrelated providers to initialize successfully.

Path-filtered CI should plan only affected roots while still expanding dependency changes: touching `modules/cloudflare/` must fan out to every Cloudflare sync root that consumes it, and the same rule applies to Neon and Supabase reusable modules.

## Admission rule

A module is not deployable merely because it exists. For each enabled provider, promotion requires a committed provider-native entrypoint and a provider sync root that can see the module. Mirrors, generated snapshots, or sibling monorepos are not deploy sources. This PR establishes layout/discovery metadata only; it does not connect providers or apply live infrastructure.
