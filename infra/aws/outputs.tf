output "cluster" {
  value = aws_ecs_cluster.main.name
}
output "migration_task" {
  value = aws_ecs_task_definition.backend["migrate"].arn
}
output "private_subnets" {
  value = aws_subnet.private[*].id
}
output "task_security_group" {
  value = aws_security_group.tasks.id
}
output "database_endpoint" {
  value = aws_db_instance.main.address
}
output "database_admin_secret" {
  value = aws_db_instance.main.master_user_secret[0].secret_arn
}
output "application_secret" {
  value = aws_secretsmanager_secret.app.arn
}
output "migration_secret" {
  value = aws_secretsmanager_secret.migration.arn
}
output "repositories" {
  value = {
    for key, repo in aws_ecr_repository.images : key => repo.repository_url
  }
}
output "api_url" {
  value = "https://${var.api_domain}"
}
output "website_url" {
  value = "https://${var.web_domain}"
}
output "alert_topic" {
  value = aws_sns_topic.alerts.arn
}
