resource "aws_ecr_repository" "images" {
  for_each             = toset(["backend", "web"])
  name                 = "${local.name}/${each.key}"
  image_tag_mutability = "IMMUTABLE"
  image_scanning_configuration {
    scan_on_push = true
  }
  encryption_configuration {
    encryption_type = "AES256"
  }
}
resource "aws_ecs_cluster" "main" {
  name = local.name
  setting {
    name  = "containerInsights"
    value = "enabled"
  }
}
resource "aws_cloudwatch_log_group" "service" {
  for_each          = toset(["api", "worker", "migrate", "web"])
  name              = "/clubby/${var.environment}/${each.key}"
  retention_in_days = 30
}
resource "aws_iam_role" "execution" {
  for_each = toset(["api", "worker", "migrate", "web"])
  name     = "${local.name}-${each.key}-execution"
  assume_role_policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Principal = {
        Service = "ecs-tasks.amazonaws.com"
      }, Action = "sts:AssumeRole"
      }
    ]
  })
}
resource "aws_iam_role_policy_attachment" "execution" {
  for_each   = aws_iam_role.execution
  role       = each.value.name
  policy_arn = "arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy"
}
resource "aws_iam_role_policy" "secrets" {
  for_each = toset(["api", "worker", "migrate"])
  role     = aws_iam_role.execution[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect   = "Allow", Action = ["secretsmanager:GetSecretValue"],
      Resource = each.key == "migrate" ? [aws_secretsmanager_secret.migration.arn] : [aws_secretsmanager_secret.app.arn]
      }
    ]
  })
}
resource "aws_iam_role" "task" {
  for_each           = toset(["api", "worker", "migrate", "web"])
  name               = "${local.name}-${each.key}-task"
  assume_role_policy = aws_iam_role.execution[each.key].assume_role_policy
}
resource "aws_iam_role_policy" "storage" {
  for_each = toset(["api", "worker"])
  role     = aws_iam_role.task[each.key].id
  policy = jsonencode({
    Version = "2012-10-17", Statement = [{
      Effect = "Allow", Action = ["s3:GetObject", "s3:PutObject", "s3:DeleteObject"], Resource = "${aws_s3_bucket.media.arn}/*"
      }
    ]
  })
}
locals {
  common_environment = {
    APP_ENV             = var.environment, HOST = "0.0.0.0", PORT = "4100", WORKER_HEALTH_PORT = "4101",
    WEB_ORIGINS         = "https://${var.web_domain}", PUBLIC_API_URL = "https://${var.api_domain}",
    DATABASE_CA_PATH    = "/app/certs/rds-ca.pem", RELEASE_REVISION = var.revision,
    TRUSTED_PROXY_CIDRS = join(",", aws_subnet.public[*].cidr_block),
    HTTP_RATE_LIMIT     = tostring(var.http_rate_limit), STORAGE_MODE = "s3", S3_REGION = var.region,
    S3_BUCKET           = aws_s3_bucket.media.id, EMAIL_MODE = var.email_mode,
    STRIPE_MODE         = var.stripe_mode, STRIPE_ONBOARDING_ORIGIN = "https://${var.web_domain}",
    LIVE_COMMERCE       = tostring(var.live_commerce), LOG_LEVEL = "info"
  }
}
resource "aws_ecs_task_definition" "backend" {
  for_each                 = toset(["api", "worker", "migrate"])
  family                   = "${local.name}-${each.key}"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "512"
  memory                   = "1024"
  execution_role_arn       = aws_iam_role.execution[each.key].arn
  task_role_arn            = aws_iam_role.task[each.key].arn
  runtime_platform {
    operating_system_family = "LINUX"
    cpu_architecture        = "X86_64"
  }
  container_definitions = jsonencode([merge({
    name        = each.key, image = var.backend_image, essential = true, command = [each.key], user = "1000:1000",
    stopTimeout = 120,
    linuxParameters = {
      initProcessEnabled = true, capabilities = {
        drop = ["ALL"]
      }
    },
    environment = [for k, v in merge(each.key == "migrate" ? {} : var.additional_environment, local.common_environment, {
      SERVICE_KIND = each.key
      },
      each.key == "migrate" ? {
        LIVE_COMMERCE = "false", STRIPE_MODE = "disabled", EMAIL_MODE = "disabled", STORAGE_MODE = "disabled"
      }
      : {
      }) : {
      name = k, value = v
      }
    ],
    secrets = [for k in each.key == "migrate" ? toset(["DATABASE_URL"]) : setunion(var.secret_keys, toset(["DATABASE_URL"])) : {
      name = k, valueFrom = "${each.key == "migrate" ? aws_secretsmanager_secret.migration.arn : aws_secretsmanager_secret.app.arn}:${k}::"
      }
    ],
    logConfiguration = {
      logDriver = "awslogs", options = {
        awslogs-group = aws_cloudwatch_log_group.service[each.key].name, awslogs-region = var.region, awslogs-stream-prefix = each.key
      }
    }
    }, jsondecode(each.key == "migrate" ? "{}" : jsonencode({
      portMappings = [{
        containerPort = each.key == "api" ? 4100 : 4101, protocol = "tcp"
        }
      ],
      healthCheck = {
        command = ["CMD", "node", "scripts/healthcheck.mjs"], interval = 30, timeout = 5, retries = 3, startPeriod = 60
      }
  })))])
  lifecycle {
    precondition {
      condition     = !var.live_commerce || (var.environment == "production" && var.stripe_mode == "live" && contains(var.secret_keys, "RELEASE_APPROVAL_JSON"))
      error_message = "Live commerce requires a production release approval secret."
    }
    precondition {
      condition     = !contains(keys(var.additional_environment), "DATABASE_URL") && !contains(keys(var.additional_environment), "APP_ENCRYPTION_KEY")
      error_message = "Credentials must use secret_keys, never environment values."
    }
  }
}
resource "aws_ecs_task_definition" "web" {
  family                   = "${local.name}-web"
  requires_compatibilities = ["FARGATE"]
  network_mode             = "awsvpc"
  cpu                      = "256"
  memory                   = "512"
  execution_role_arn       = aws_iam_role.execution["web"].arn
  task_role_arn            = aws_iam_role.task["web"].arn
  container_definitions = jsonencode([{
    name = "web", image = var.web_image, essential = true, user = "1000:1000", readonlyRootFilesystem = true,
    portMappings = [{
      containerPort = 8080, protocol = "tcp"
      }
    ], stopTimeout = 30,
    linuxParameters = {
      initProcessEnabled = true, capabilities = {
        drop = ["ALL"]
      }
    },
    environment = [{
      name = "PUBLIC_API_URL", value = "https://${var.api_domain}"
      }, {
      name = "PORT", value = "8080"
      }
    ],
    healthCheck = {
      command = ["CMD", "node", "scripts/healthcheck.mjs"], interval = 30, timeout = 5, retries = 3, startPeriod = 15
    },
    logConfiguration = {
      logDriver = "awslogs", options = {
        awslogs-group = aws_cloudwatch_log_group.service["web"].name, awslogs-region = var.region, awslogs-stream-prefix = "web"
      }
    }
    }
  ])
}
resource "aws_ecs_service" "main" {
  for_each                           = toset(["api", "worker", "web"])
  name                               = "${local.name}-${each.key}"
  cluster                            = aws_ecs_cluster.main.id
  task_definition                    = each.key == "web" ? aws_ecs_task_definition.web.arn : aws_ecs_task_definition.backend[each.key].arn
  desired_count                      = var.services_enabled ? (var.environment == "production" ? 2 : 1) : 0
  launch_type                        = "FARGATE"
  platform_version                   = "1.4.0"
  enable_execute_command             = false
  health_check_grace_period_seconds  = each.key == "worker" ? null : 90
  deployment_minimum_healthy_percent = 100
  deployment_maximum_percent         = 200
  deployment_circuit_breaker {
    enable   = true
    rollback = true
  }
  network_configuration {
    subnets          = aws_subnet.private[*].id
    security_groups  = [aws_security_group.tasks.id]
    assign_public_ip = false
  }
  dynamic "load_balancer" {
    for_each = each.key == "worker" ? [] : [each.key]
    content {
      target_group_arn = aws_lb_target_group.main[each.key].arn
      container_name   = each.key
      container_port   = each.key == "api" ? 4100 : 8080
    }
  }
  depends_on = [aws_lb_listener.https, aws_lb_listener_rule.host, aws_iam_role_policy.secrets, aws_iam_role_policy_attachment.execution]
}
