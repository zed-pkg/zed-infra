# Public commercial-intake host. The path-specific Worker owns only
# org.zpkg.net/quote and rejects every wildcard overmatch. The proxied record
# is still required for Cloudflare Worker Routes to execute.
resource "cloudflare_dns_record" "org" {
  zone_id = var.zone_id
  name    = "org.zpkg.net"
  type    = "CNAME"
  content = var.web_origin != "" ? var.web_origin : var.primary_origin
  proxied = true
  ttl     = 1
}
