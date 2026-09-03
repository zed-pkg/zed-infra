# AWS ECR module

Creates a private, immutable ECR repository suitable for same-region AWS Lambda images. It enables scan-on-push, retains a bounded rollback window, blocks force deletion, and optionally installs a Lambda service pull policy restricted by source ARN/account.

Configure the AWS provider in the calling root. Use GitHub Actions OIDC or another short-lived identity; this module intentionally creates no IAM user, access key, password, or Docker credential.
