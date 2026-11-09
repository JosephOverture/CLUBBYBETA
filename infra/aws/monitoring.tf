resource "aws_kms_key" "alerts" {
  description             = "Clubby operational alert encryption"
  enable_key_rotation     = true
  deletion_window_in_days = 30
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "kms:*", Resource = "*" },
    { Effect = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" }, Action = ["kms:Decrypt", "kms:GenerateDataKey*"], Resource = "*",
    Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }, ArnLike = { "aws:SourceArn" = "arn:aws:cloudwatch:${var.region}:${data.aws_caller_identity.current.account_id}:alarm:${local.name}-*" } } }
  ] })
}
resource "aws_sns_topic" "alerts" {
  name              = "${local.name}-alerts"
  kms_master_key_id = aws_kms_key.alerts.id
}
resource "aws_sns_topic_policy" "alerts" {
  arn = aws_sns_topic.alerts.arn
  policy = jsonencode({ Version = "2012-10-17", Statement = [
    { Effect = "Allow", Principal = { AWS = "arn:aws:iam::${data.aws_caller_identity.current.account_id}:root" }, Action = "sns:*", Resource = aws_sns_topic.alerts.arn },
    { Effect = "Allow", Principal = { Service = "cloudwatch.amazonaws.com" }, Action = "sns:Publish", Resource = aws_sns_topic.alerts.arn,
    Condition = { StringEquals = { "aws:SourceAccount" = data.aws_caller_identity.current.account_id }, ArnLike = { "aws:SourceArn" = "arn:aws:cloudwatch:${var.region}:${data.aws_caller_identity.current.account_id}:alarm:${local.name}-*" } } }
  ] })
}
resource "aws_sns_topic_subscription" "operator" {
  topic_arn = aws_sns_topic.alerts.arn
  protocol  = "email"
  endpoint  = var.alert_email
}
locals {
  operation_metrics = {
    DeadJobs     = "dead_jobs", QueueAge = "oldest_due_seconds", ExpiredLeases = "expired_leases",
    OrderReviews = "order_reviews", RefundReviews = "refund_reviews", OverdueDeletions = "overdue_deletions", Workers = "workers"
  }
}
resource "aws_cloudwatch_log_metric_filter" "operations" {
  for_each       = local.operation_metrics
  name           = "${local.name}-${each.key}"
  log_group_name = aws_cloudwatch_log_group.service["worker"].name
  pattern        = "{ $.event = \"operations.snapshot\" }"
  metric_transformation {
    name      = each.key
    namespace = "Clubby/${var.environment}"
    value     = "$.${each.value}"
  }
}
resource "aws_cloudwatch_metric_alarm" "operations" {
  for_each            = local.operation_metrics
  alarm_name          = "${local.name}-${each.key}"
  alarm_description   = "Follow docs/runbooks/operations.md and investigate in the administrator Operations screen."
  namespace           = "Clubby/${var.environment}"
  metric_name         = each.key
  statistic           = each.key == "Workers" ? "Minimum" : "Maximum"
  period              = 60
  evaluation_periods  = 3
  threshold           = each.key == "QueueAge" ? 300 : (each.key == "Workers" ? 1 : 0)
  comparison_operator = each.key == "Workers" ? "LessThanThreshold" : "GreaterThanThreshold"
  treat_missing_data  = var.services_enabled && each.key == "Workers" ? "breaching" : "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
  ok_actions          = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "api_errors" {
  alarm_name  = "${local.name}-api-5xx"
  namespace   = "AWS/ApplicationELB"
  metric_name = "HTTPCode_Target_5XX_Count"
  dimensions = {
    LoadBalancer = aws_lb.main.arn_suffix, TargetGroup = aws_lb_target_group.main["api"].arn_suffix
  }
  statistic           = "Sum"
  period              = 60
  evaluation_periods  = 3
  threshold           = 5
  comparison_operator = "GreaterThanThreshold"
  treat_missing_data  = "notBreaching"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_metric_alarm" "database_space" {
  alarm_name  = "${local.name}-database-space"
  namespace   = "AWS/RDS"
  metric_name = "FreeStorageSpace"
  dimensions = {
    DBInstanceIdentifier = aws_db_instance.main.id
  }
  statistic           = "Minimum"
  period              = 300
  evaluation_periods  = 2
  threshold           = 5368709120
  comparison_operator = "LessThanThreshold"
  alarm_actions       = [aws_sns_topic.alerts.arn]
}
resource "aws_cloudwatch_dashboard" "operations" {
  dashboard_name = local.name
  dashboard_body = jsonencode({
    widgets = [for index, key in sort(keys(local.operation_metrics)) : {
      type = "metric", x = (index % 3) * 8, y = floor(index / 3) * 6, width = 8, height = 6,
      properties = {
        title = key, region = var.region, period = 60, stat = "Maximum", metrics = [["Clubby/${var.environment}", key]]
      }
      }
    ]
  })
}
