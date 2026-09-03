# Crossplane OCI repository resources

These provider-native examples reconcile the repository control plane after Terraform has bootstrapped the cluster, providers, and identities. Pin provider package versions in the platform-control-plane repository; do not install floating `latest` packages from an application repository.

Crossplane provisions repositories. It does not build or push images. Image promotion remains a CI/runtime action performed by `scripts/promote-oci-image.sh` under workload identity. `deletionPolicy: Orphan` prevents deleting a registry full of rollback evidence when a managed-resource object is removed.

R2 remains Terraform-only in this contract because the bucket is a storage backend, not a first-class OCI endpoint. A registry service in front of R2 must have a separate threat model, credentials, network policy, backup, and garbage-collection review.
