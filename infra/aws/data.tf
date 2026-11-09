resource "aws_db_subnet_group" "main" {
  name       = local.name
  subnet_ids = aws_subnet.private[*].id
}
resource "aws_db_parameter_group" "main" {
  name_prefix = "${local.name}-"
  family      = "postgres17"
  parameter {
    name  = "rds.force_ssl"
    value = "1"
  }
  parameter {
    name  = "log_statement"
    value = "none"
  }
  parameter {
    name  = "log_min_error_statement"
    value = "panic"
  }
}
resource "aws_db_instance" "main" {
  identifier                      = local.name
  engine                          = "postgres"
  engine_version                  = "17"
  instance_class                  = var.database_class
  allocated_storage               = 30
  max_allocated_storage           = 200
  storage_type                    = "gp3"
  storage_encrypted               = true
  db_name                         = "clubby"
  username                        = "clubby_admin"
  manage_master_user_password     = true
  port                            = 5432
  db_subnet_group_name            = aws_db_subnet_group.main.name
  vpc_security_group_ids          = [aws_security_group.database.id]
  parameter_group_name            = aws_db_parameter_group.main.name
  publicly_accessible             = false
  multi_az                        = var.environment == "production"
  backup_retention_period         = 35
  backup_window                   = "02:00-03:00"
  maintenance_window              = "sun:04:00-sun:05:00"
  copy_tags_to_snapshot           = true
  deletion_protection             = true
  skip_final_snapshot             = false
  final_snapshot_identifier       = "${local.name}-final"
  auto_minor_version_upgrade      = true
  apply_immediately               = false
  enabled_cloudwatch_logs_exports = ["postgresql", "upgrade"]
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_s3_bucket" "media" {
  bucket_prefix = "${local.name}-media-"
  force_destroy = false
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_s3_bucket_public_access_block" "media" {
  bucket                  = aws_s3_bucket.media.id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}
resource "aws_s3_bucket_ownership_controls" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}
resource "aws_s3_bucket_server_side_encryption_configuration" "media" {
  bucket = aws_s3_bucket.media.id
  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm = "AES256"
    }
  }
}
# Do not enable object versioning here: deletion must remove the actual private media bytes.
# Database PITR is independent. Recovery of erased media is deliberately unsupported.
resource "aws_s3_bucket_policy" "media" {
  bucket = aws_s3_bucket.media.id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect   = "Deny", Principal = "*", Action = "s3:*",
      Resource = [aws_s3_bucket.media.arn, "${aws_s3_bucket.media.arn}/*"],
      Condition = {
        Bool = {
          "aws:SecureTransport" = "false"
        }
      }
      }
    ]
    }
  )
}
resource "aws_secretsmanager_secret" "app" {
  name                    = "${local.name}/application"
  recovery_window_in_days = 30
  lifecycle {
    prevent_destroy = true
  }
}
resource "aws_secretsmanager_secret" "migration" {
  name                    = "${local.name}/migration"
  recovery_window_in_days = 30
  lifecycle {
    prevent_destroy = true
  }
}
# Values are intentionally provisioned outside Terraform so credentials never enter state.
