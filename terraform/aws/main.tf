terraform {
  required_version = ">= 1.6"
  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
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

resource "aws_iam_access_key" "api" {
  user = aws_iam_user.api.name
}
