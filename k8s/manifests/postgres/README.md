# Postgres for zed-pkg

Production: do **not** run the dev StatefulSet. Use one of:

- **[CloudNativePG](https://cloudnative-pg.io/)** — Postgres operator with
  backups, failover, and PITR. Recommended for self-hosted clusters.
- A **managed database** — Supabase, Neon, RDS, Cloud SQL. Point
  `DATABASE_URL` at it via the `zed-api-server-secrets` secret.

Dev/testing: `k8s/manifests/zed-api-server/overlays/dev/postgres-dev.yaml`
ships a single-replica StatefulSet with an ephemeral password, pulled in by
the dev overlay only.

The API server (`zed-api-server`) owns the schema and runs migrations on
boot (`AUTO_MIGRATE=true`); the web server reads the same database.
