# Shared Auth topology

DEN-2843 adds the role-aware Supabase + Neon Shared Auth contract to Zed's
existing database-isolation and deployment controls. It does not modify generated
manifests, make production implicit, or commit provider credentials.

Customer web/API servers use `SUPABASE_AUTH_DATABASE_URL` and
`NEON_AUTH_DATABASE_URL`. Admin web/API servers use the independent
`SUPABASE_ADMIN_DATABASE_URL` and `NEON_ADMIN_DATABASE_URL` settings with no
customer fallback. Both providers are required; admin and sensitive registry
operations use strict paired proof. The shared `oresoftware` Supabase runtime
placement is schema-isolated and transitional, while `zed-pkg` remains the target
Supabase and dedicated Neon organization. Run `node shared-auth/validate.mjs`.
