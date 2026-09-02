output "registry_id" {
  value       = azurerm_container_registry.this.id
  description = "Azure resource ID."
}

output "login_server" {
  value       = azurerm_container_registry.this.login_server
  description = "Registry hostname used as the promotion destination."
}
