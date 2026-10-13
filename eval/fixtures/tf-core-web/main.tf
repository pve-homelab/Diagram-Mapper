terraform {
  required_version = ">= 1.6.0"

  required_providers {
    aws = {
      source  = "hashicorp/aws"
      version = "~> 5.0"
    }
  }
}

provider "aws" {
  region = "eu-west-2"
}

resource "aws_lb" "public" {
  name               = "core-web-alb"
  internal           = false
  load_balancer_type = "application"
  security_groups    = [aws_security_group.alb.id]
  subnets            = [aws_subnet.public_a.id, aws_subnet.public_b.id]
}

resource "aws_lb_target_group" "app" {
  name        = "core-web-app"
  port        = 8080
  protocol    = "HTTP"
  target_type = "ip"
  vpc_id      = aws_vpc.main.id

  health_check {
    path                = "/healthz"
    healthy_threshold   = 2
    unhealthy_threshold = 3
  }
}

resource "aws_lb_listener" "https" {
  load_balancer_arn = aws_lb.public.arn
  port              = 443
  protocol          = "HTTPS"
  ssl_policy        = "ELBSecurityPolicy-TLS13-1-2-2021-06"

  default_action {
    type             = "forward"
    target_group_arn = aws_lb_target_group.app.arn
  }
}

resource "aws_ecs_cluster" "main" {
  name = "core-web"
}

resource "aws_ecs_service" "app" {
  name            = "core-web-app"
  cluster         = aws_ecs_cluster.main.id
  task_definition = aws_ecs_task_definition.app.arn
  desired_count   = var.desired_task_count
  launch_type     = "FARGATE"

  network_configuration {
    subnets         = [aws_subnet.private_a.id, aws_subnet.private_b.id]
    security_groups = [aws_security_group.service.id]
  }

  load_balancer {
    target_group_arn = aws_lb_target_group.app.arn
    container_name   = "app"
    container_port   = 8080
  }
}

resource "aws_ecs_task_definition" "app" {
  family                   = "core-web-app"
  cpu                      = 512
  memory                   = 1024
  network_mode             = "awsvpc"
  requires_compatibilities = ["FARGATE"]
  execution_role_arn       = aws_iam_role.task_execution.arn
}

resource "aws_iam_role" "task_execution" {
  name               = "core-web-task-execution"
  assume_role_policy = file("policies/ecs-assume-role.json")
}

resource "aws_instance" "bastion" {
  ami                         = "ami-0abcdef1234567890"
  instance_type               = "t3.micro"
  subnet_id                   = aws_subnet.public_a.id
  vpc_security_group_ids      = [aws_security_group.bastion.id]
  associate_public_ip_address = true
}

resource "aws_db_instance" "primary" {
  identifier             = "core-web-primary"
  engine                 = "postgres"
  engine_version         = "15.5"
  instance_class         = "db.t3.medium"
  allocated_storage      = 100
  username               = "appuser"
  password               = var.db_password
  db_subnet_group_name   = aws_db_subnet_group.private.name
  vpc_security_group_ids = [aws_security_group.database.id]
  storage_encrypted      = true
  publicly_accessible    = false
  multi_az               = true
  backup_retention_period = 7
}

resource "aws_db_subnet_group" "private" {
  name       = "core-web-private"
  subnet_ids = [aws_subnet.private_a.id, aws_subnet.private_b.id]
}

resource "aws_s3_bucket" "assets" {
  bucket = "core-web-static-assets"
}

output "alb_dns_name" {
  value = aws_lb.public.dns_name
}
