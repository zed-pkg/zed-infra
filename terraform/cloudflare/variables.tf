variable "cloudflare_api_token" {
  description = "Cloudflare API token with R2 + DNS edit permissions"
  type        = string
  sensitive   = true
}

variable "account_id" {
  description = "Cloudflare account id (also the R2 S3 endpoint host prefix)"
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone id for zpkg.tech"
  type        = string
}

variable "r2_location" {
  description = "R2 bucket location hint (e.g. wnam, enam, weur)"
  type        = string
  default     = "wnam"
}

variable "registry_origin" {
  description = "Origin hostname the registry API CNAME points at"
  type        = string
  default     = "origin.zpkg.tech"
}

variable "web_origin" {
  description = "Origin hostname the registry web UI CNAME points at"
  type        = string
  default     = "origin.zpkg.tech"
}

variable "marketing_origin" {
  description = "Origin for the marketing site (GitHub Pages)"
  type        = string
  default     = "zed-pkg.github.io"
}
