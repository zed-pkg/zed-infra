variable "account_id" {
  description = "Cloudflare account id (also the R2 S3 endpoint host prefix)"
  type        = string
}

variable "zone_id" {
  description = "Cloudflare zone id for zpkg.net"
  type        = string
}

variable "r2_location" {
  description = "R2 bucket location hint (e.g. wnam, enam, weur)"
  type        = string
  default     = "wnam"
}

variable "marketing_origin" {
  description = "Origin for the marketing site (GitHub Pages)"
  type        = string
  default     = "zed-pkg.github.io"
}

variable "primary_origin" {
  description = "Origin hostname registry.zpkg.net / web.zpkg.net point at"
  type        = string
  default     = "origin-hetzner.zpkg.net"
}

variable "hetzner_ingress_ip" {
  description = "Hetzner cluster edge node (ingress-nginx hostNetwork; see ORESoftware/k8s-cluster remote/hetzner)"
  type        = string
  default     = "95.217.171.250"
}

variable "aws_gateway_ip" {
  description = "AWS cluster gateway EIP (dd-remote-gateway hostPort; see ORESoftware/k8s-cluster remote/ec2)"
  type        = string
  default     = "98.90.186.114"
}

variable "registry_origin" {
  description = "Transitional override for registry.zpkg.net's target. Today the record is a CNAME to the zpkg-registry-local tunnel (a laptop origin — see DEN-2760); set this to that tunnel hostname to keep the registry serving until DEN-534/DEN-535 promote the cluster API, then clear it. Empty = primary_origin."
  type        = string
  default     = ""
}

variable "api_origin" {
  description = "Transitional override for api.zpkg.net's target — same tunnel story as registry_origin (api and registry share the zed-api-server root today). Clear once DEN-534/DEN-535 promote the cluster API. Empty = primary_origin."
  type        = string
  default     = ""
}

variable "web_origin" {
  description = "Transitional override for web.zpkg.net's target — the tunnel fronting a locally run zed-web-server (port 8081) while the Hetzner origin is down (billing) and the clusters have no zed apps (DEN-2881). Empty = primary_origin."
  type        = string
  default     = ""
}

variable "proxy_app_records" {
  description = "Proxy registry.zpkg.net / web.zpkg.net through Cloudflare. Keep false until cert-manager has issued the HTTP-01 certs on the cluster, or issuance deadlocks."
  type        = bool
  default     = false
}
