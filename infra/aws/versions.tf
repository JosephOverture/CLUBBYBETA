terraform {
  required_version = ">= 1.10, < 2.0"
  required_providers {
    aws = {
      source = "hashicorp/aws", version = "~> 6.0"
    }
  }
  # Initialize with a separate encrypted, versioned S3 state bucket per account/environment.
  backend "s3" {
  }
}
provider "aws" {
  region = var.region
  default_tags {
    tags = {
      Application = "clubby", Environment = var.environment, ManagedBy = "terraform"
    }
  }
}
data "aws_availability_zones" "available" {
  state = "available"
}
data "aws_caller_identity" "current" {
}
locals {
  name  = "clubby-${var.environment}"
  zones = slice(data.aws_availability_zones.available.names, 0, 2)
  domains = {
    web = var.web_domain, api = var.api_domain
  }
  nat_count = var.environment == "production" ? 2 : 1
}
