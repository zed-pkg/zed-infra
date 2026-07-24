terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }

  # Local state by default; switch to an S3 remote backend with DynamoDB state
  # locking for teams. Remote state is encrypted at rest and versioned, which
  # matters here because IAM access-key secrets land in state (see below).
  # backend "s3" {
  #   bucket         = "zed-tfstate"
  #   key            = "aws/terraform.tfstate"
  #   region         = "us-east-1"
  #   dynamodb_table = "zed-tfstate-lock"
  #   encrypt        = true
  # }
}

provider "aws" {
  region = var.region
}

# Alternative artifact backend on AWS S3 (R2 is the default; this is here for
# AWS-native deployments). Private bucket, all public access blocked.
resource "aws_s3_bucket" "artifacts" {
  bucket = var.bucket_name
}

resource "aws_s3_bucket_public_access_block" "artifacts" {
  bucket                  = aws_s3_bucket.artifacts.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_lifecycle_configuration" "artifacts" {
  bucket = aws_s3_bucket.artifacts.id
  rule {
    id     = "abort-incomplete-multipart"
    status = "Enabled"
    filter {} # apply to all objects
    abort_incomplete_multipart_upload {
      days_after_initiation = 7
    }
  }
}

# Least-privilege user for zed-api-server (get/put/list on this bucket only).
resource "aws_iam_user" "api" {
  name = "zed-api-server"
}

resource "aws_iam_user_policy" "api" {
  name = "zed-artifacts-rw"
  user = aws_iam_user.api.name
  policy = jsonencode({
    Version = "2012-10-17"
    Statement = [
      {
        Effect   = "Allow"
        Action   = ["s3:GetObject", "s3:PutObject"]
        Resource = "${aws_s3_bucket.artifacts.arn}/*"
      },
      {
        Effect   = "Allow"
        Action   = ["s3:ListBucket"]
        Resource = aws_s3_bucket.artifacts.arn
      }
    ]
  })
}

# SECURITY: This mints a long-lived static IAM access key whose secret is stored
# in plaintext in Terraform state (no encrypted remote backend is configured
# above). For production, prefer IRSA / OIDC: bind the zed-api-server Kubernetes
# ServiceAccount to an IAM role via an OIDC trust policy (EKS Pod Identity or
# IRSA) so pods receive short-lived, auto-rotated credentials and no static
# secret is ever created or persisted to state. Keep this key only for local/dev
# or non-EKS deployments, and rotate it regularly.
resource "aws_iam_access_key" "api" {
  user = aws_iam_user.api.name
}
