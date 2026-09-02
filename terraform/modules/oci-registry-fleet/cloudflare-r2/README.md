# Cloudflare R2 blob-backend module

Creates an R2 bucket for a separately deployed OCI Distribution-compatible registry or cache. This does **not** create a registry endpoint and the bucket must not be referenced directly by Docker, Cloud Run, or Lambda. Registry authentication, TLS, S3 credentials, garbage collection, and `/v2/` behavior belong to a separate reviewed workload.
