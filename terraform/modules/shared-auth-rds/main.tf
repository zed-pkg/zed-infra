terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = ">= 5.0"
    }
  }
}

locals {
  identifier = lower(replace(var.name, "_", "-"))
  tags = merge(var.tags, {
    Name       = local.identifier
    Component  = "shared-auth"
    DataPlane  = "customer-auth"
    ManagedBy  = "terraform"
  })
}

resource "aws_db_subnet_group" "this" {
  name       = "${local.identifier}-subnets"
  subnet_ids = var.private_subnet_ids
  tags       = local.tags
}

resource "aws_security_group" "this" {
  name_prefix = "${local.identifier}-rds-"
  description = "PostgreSQL access for the dedicated Shared Auth data plane"
  vpc_id      = var.vpc_id

  dynamic "ingress" {
    for_each = toset(var.source_security_group_ids)
    content {
      description     = "PostgreSQL from an approved Shared Auth client security group"
      protocol        = "tcp"
      from_port       = var.port
      to_port         = var.port
      security_groups = [ingress.value]
    }
  }

  # RDS does not require arbitrary outbound application access. AWS may still
  # manage the service through its control plane without a broad SG egress rule.
  egress = []

  lifecycle {
    create_before_destroy = true
  }

  tags = local.tags
}

resource "aws_db_instance" "this" {
  identifier = local.identifier

  engine         = "postgres"
  engine_version = var.engine_version
  instance_class = var.instance_class
  port           = var.port

  db_name  = var.database_name
  username = var.master_username

  # AWS Secrets Manager owns and rotates the generated master credential. No
  # password enters Terraform configuration, state input, Git, or Kubernetes.
  manage_master_user_password   = true
  master_user_secret_kms_key_id = var.master_user_secret_kms_key_id

  allocated_storage     = var.allocated_storage_gib
  max_allocated_storage = var.max_allocated_storage_gib
  storage_type          = var.storage_type
  storage_encrypted     = true
  kms_key_id            = var.storage_kms_key_id

  db_subnet_group_name   = aws_db_subnet_group.this.name
  vpc_security_group_ids = [aws_security_group.this.id]
  publicly_accessible    = false
  multi_az               = var.multi_az

  backup_retention_period = var.backup_retention_days
  backup_window           = var.backup_window
  maintenance_window      = var.maintenance_window
  copy_tags_to_snapshot   = true
  delete_automated_backups = false

  auto_minor_version_upgrade = true
  apply_immediately          = false
  deletion_protection        = var.deletion_protection

  skip_final_snapshot       = var.skip_final_snapshot
  final_snapshot_identifier = var.skip_final_snapshot ? null : var.final_snapshot_identifier

  performance_insights_enabled          = var.performance_insights_enabled
  performance_insights_retention_period = var.performance_insights_enabled ? var.performance_insights_retention_days : null
  performance_insights_kms_key_id        = var.performance_insights_enabled ? var.performance_insights_kms_key_id : null

  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]

  lifecycle {
    precondition {
      condition     = var.skip_final_snapshot || var.final_snapshot_identifier != null
      error_message = "final_snapshot_identifier is required when skip_final_snapshot is false."
    }
  }

  tags = local.tags
}
