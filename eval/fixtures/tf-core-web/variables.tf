variable "environment" {
  description = "Deployment environment name."
  type        = string
  default     = "production"
}

variable "vpc_cidr" {
  description = "CIDR block for the application VPC."
  type        = string
  default     = "10.20.0.0/16"
}

variable "db_password" {
  description = "Master password for the primary database."
  type        = string
  sensitive   = true
}

variable "desired_task_count" {
  description = "Number of ECS tasks to run."
  type        = number
  default     = 3
}
