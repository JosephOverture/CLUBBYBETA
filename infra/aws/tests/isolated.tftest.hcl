mock_provider "aws" {
  mock_data "aws_availability_zones" {
    defaults = { names = ["eu-central-1a", "eu-central-1b"] }
  }
  mock_resource "aws_acm_certificate" {
    defaults = {
      domain_validation_options = [{
        domain_name = "clubby.example", resource_record_name = "_web.clubby.example", resource_record_type = "CNAME", resource_record_value = "validation.example"
        }, {
        domain_name = "api.clubby.example", resource_record_name = "_api.clubby.example", resource_record_type = "CNAME", resource_record_value = "validation.example"
      }]
    }
  }
}
variables {
  environment   = "production"
  zone_id       = "ZTEST"
  web_domain    = "clubby.example"
  api_domain    = "api.clubby.example"
  backend_image = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/backend@sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  web_image     = "123456789012.dkr.ecr.eu-central-1.amazonaws.com/web@sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
  revision      = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
  alert_email   = "operator@example.test"
}
run "private_default" {
  command = plan
  assert {
    condition     = aws_db_instance.main.publicly_accessible == false && aws_db_instance.main.storage_encrypted && aws_db_instance.main.multi_az
    error_message = "Production data must stay private, encrypted and redundant."
  }
  assert {
    condition     = alltrue([for service in aws_ecs_service.main : service.desired_count == 0 && service.network_configuration[0].assign_public_ip == false])
    error_message = "No service should run before explicit environment activation."
  }
  assert {
    condition     = aws_db_instance.main.backup_retention_period == 35 && aws_db_instance.main.deletion_protection
    error_message = "Recovery and deletion protection are mandatory."
  }
  assert {
    condition     = aws_s3_bucket_public_access_block.media.block_public_policy && aws_s3_bucket_public_access_block.media.restrict_public_buckets
    error_message = "Private media may not be published directly."
  }
}
run "live_requires_evidence" {
  command = plan
  variables { live_commerce = true }
  expect_failures = [aws_ecs_task_definition.backend]
}
