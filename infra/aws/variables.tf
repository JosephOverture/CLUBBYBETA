variable "region" {
  type    = string
  default = "eu-central-1"
}
variable "environment" {
  type = string
  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "Use an isolated staging or production stack."
  }
}
variable "zone_id" {
  type = string
}
variable "web_domain" {
  type = string
}
variable "api_domain" {
  type = string
}
variable "backend_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.backend_image))
    error_message = "Pin the backend image digest."
  }
}
variable "web_image" {
  type = string
  validation {
    condition     = can(regex("@sha256:[a-f0-9]{64}$", var.web_image))
    error_message = "Pin the website image digest."
  }
}
variable "revision" {
  type = string
  validation {
    condition     = can(regex("^[a-f0-9]{40}$", var.revision))
    error_message = "Use the exact Git revision built into both artifacts."
  }
}
variable "services_enabled" {
  type    = bool
  default = false
}
variable "live_commerce" {
  type    = bool
  default = false
}
variable "stripe_mode" {
  type    = string
  default = "disabled"
  validation {
    condition     = contains(["disabled", "test", "live"], var.stripe_mode)
    error_message = "Invalid Stripe mode."
  }
}
variable "email_mode" {
  type    = string
  default = "disabled"
  validation {
    condition     = contains(["disabled", "resend"], var.email_mode)
    error_message = "Invalid deployed email mode."
  }
}
variable "http_rate_limit" {
  type    = number
  default = 600
}
variable "additional_environment" {
  type = map(string)
  default = {
  }
}
variable "secret_keys" {
  type        = set(string)
  default     = ["APP_ENCRYPTION_KEY"]
  description = "Keys present in the app Secrets Manager JSON. Add Stripe/email/Apple credentials when activating those providers. DATABASE_URL is injected separately."
}
variable "alert_email" {
  type = string
  validation {
    condition     = can(regex("^[^@ ]+@[^@ ]+\\.[^@ ]+$", var.alert_email))
    error_message = "Set the responsible operator's alert email and confirm the SNS subscription."
  }
}
variable "database_class" {
  type    = string
  default = "db.t4g.small"
}
variable "vpc_cidr" {
  type    = string
  default = "10.40.0.0/16"
}
