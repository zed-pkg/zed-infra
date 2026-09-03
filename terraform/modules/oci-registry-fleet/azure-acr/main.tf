terraform {
  required_version = ">= 1.6.0"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = ">= 4.52, < 6.0"
    }
  }
}

resource "azurerm_container_registry" "this" {
  name                          = var.registry_name
  resource_group_name           = var.resource_group_name
  location                      = var.location
  sku                           = var.sku
  admin_enabled                 = false
  public_network_access_enabled = var.public_network_access_enabled

  tags = merge(var.tags, {
    "managed-by" = "terraform"
    "oci-role"   = var.oci_role
  })

  lifecycle {
    prevent_destroy = true
  }
}
