# Azure Container Registry module

Creates a lowest-cost Basic ACR by default, disables the admin account, and blocks Terraform destruction. Retention, quarantine, geo-replication, and other Premium-only settings are deliberately absent from the Basic contract. Use workload identity/federated credentials and scoped Azure RBAC outside this module.
