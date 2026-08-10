# Shared Auth PostgreSQL RDS module

This module provisions the dedicated **customer authentication** PostgreSQL data plane used by Shared Auth and Supabase integration. It is separate from the zed-pkg registry application database.

The registry database stores the local user projection, organizations, projects, packages, memberships, licenses, artifacts, downloads, and search vectors. Passwords, refresh tokens, browser sessions, and Shared Auth session rows belong in this dedicated auth database instead.

## Security properties

- private subnets only and `publicly_accessible=false`;
- encrypted storage and optional customer-managed KMS keys;
- AWS Secrets Manager-generated master password through `manage_master_user_password=true`;
- no password variable and no credential output value;
- inbound PostgreSQL only from explicitly supplied security groups;
- Multi-AZ, deletion protection, backups, final snapshot, CloudWatch database logs, and Performance Insights enabled by production-safe defaults;
- explicit `engine_version`, because available RDS PostgreSQL versions vary by region and time.

The master secret ARN is a sensitive output. Use External Secrets, the Secrets Store CSI Driver, or another audited delivery path to create the Kubernetes `DATABASE_URL`; do not place the generated password in Terraform variables, Git, Argo CD parameters, or plaintext Secret manifests.

## Example

```hcl
module "shared_auth_customer_db" {
  source = "../../modules/shared-auth-rds"

  name                      = "shared-auth-customer-prod"
  vpc_id                    = module.network.vpc_id
  private_subnet_ids        = module.network.private_database_subnet_ids
  source_security_group_ids = [module.eks.shared_auth_node_security_group_id]

  # Choose a version verified as available in this account and region.
  engine_version            = var.shared_auth_postgres_engine_version
  instance_class            = "db.r7g.large"
  final_snapshot_identifier = "shared-auth-customer-prod-final"

  storage_kms_key_id            = aws_kms_key.rds.arn
  master_user_secret_kms_key_id = aws_kms_key.secrets.arn
  performance_insights_kms_key_id = aws_kms_key.rds.arn

  tags = {
    Environment = "prod"
    Service     = "shared-auth"
  }
}
```

## Application roles

Do not run Shared Auth as the generated RDS master user. Bootstrap narrowly scoped roles once through an audited migration path:

- migration owner: DDL only during controlled jobs;
- runtime writer: session/auth tables only;
- support reader: optional, audited, read-only access;
- rotation/administration: AWS-managed secret and break-glass process.

The zed-pkg API and web pods must never receive this auth-database connection string. They receive a Shared Auth service credential and communicate with Shared Auth over its service boundary.
