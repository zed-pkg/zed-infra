#!/usr/bin/env bash
set -euo pipefail

# Environment-only interface avoids leaking credentials through argv.
# Required: REGISTRY_PROVIDER, IMAGE_NAME, IMAGE_TAG.
required() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    printf 'missing required environment variable: %s\n' "$name" >&2
    exit 64
  fi
}

required REGISTRY_PROVIDER
required IMAGE_NAME
required IMAGE_TAG

DOCKERFILE="${DOCKERFILE:-Dockerfile}"
CONTEXT="${CONTEXT:-.}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
BUILD_TARGET="${BUILD_TARGET:-}"
BUILD_ARG_NAMES="${BUILD_ARG_NAMES:-}"
PUSH="${PUSH:-true}"
BUILDER_NAME="${BUILDER_NAME:-ores-multiarch}"

case "$PUSH" in true|false) ;; *) printf 'PUSH must be true or false\n' >&2; exit 64 ;; esac

login_registry() {
  case "$REGISTRY_PROVIDER" in
    aws-ecr)
      required REGISTRY_HOST; required AWS_REGION
      aws ecr get-login-password --region "$AWS_REGION" |
        docker login --username AWS --password-stdin "$REGISTRY_HOST"
      ;;
    dockerhub)
      required DOCKERHUB_USERNAME; required DOCKERHUB_TOKEN
      REGISTRY_HOST="${REGISTRY_HOST:-docker.io}"
      printf '%s' "$DOCKERHUB_TOKEN" |
        docker login --username "$DOCKERHUB_USERNAME" --password-stdin "$REGISTRY_HOST"
      ;;
    gcp-artifact-registry)
      required REGISTRY_HOST
      gcloud auth print-access-token |
        docker login --username oauth2accesstoken --password-stdin "https://${REGISTRY_HOST}"
      ;;
    azure-acr)
      required AZURE_ACR_NAME
      REGISTRY_HOST="${REGISTRY_HOST:-${AZURE_ACR_NAME}.azurecr.io}"
      az acr login --name "$AZURE_ACR_NAME"
      ;;
    none) required REGISTRY_HOST ;;
    *) printf 'unsupported REGISTRY_PROVIDER: %s\n' "$REGISTRY_PROVIDER" >&2; exit 64 ;;
  esac
}

login_registry
REGISTRY_HOST="${REGISTRY_HOST%/}"
IMAGE_NAME="${IMAGE_NAME#/}"
IMAGE_REF="${REGISTRY_HOST}/${IMAGE_NAME}:${IMAGE_TAG}"

if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --use >/dev/null
else
  docker buildx use "$BUILDER_NAME"
fi
docker buildx inspect --bootstrap >/dev/null

args=(docker buildx build --file "$DOCKERFILE" --platform "$PLATFORMS" --tag "$IMAGE_REF" --provenance=mode=max --sbom=true)
[[ -z "$BUILD_TARGET" ]] || args+=(--target "$BUILD_TARGET")

if [[ -n "$BUILD_ARG_NAMES" ]]; then
  IFS=',' read -r -a names <<<"$BUILD_ARG_NAMES"
  for name in "${names[@]}"; do
    name="${name//[[:space:]]/}"
    [[ -n "$name" ]] || continue
    [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || { printf 'invalid build arg: %s\n' "$name" >&2; exit 64; }
    required "$name"
    args+=(--build-arg "${name}=${!name}")
  done
fi

if [[ "$PUSH" == true ]]; then
  args+=(--push)
else
  [[ "$PLATFORMS" != *,* ]] || { printf 'PUSH=false supports one platform only\n' >&2; exit 64; }
  args+=(--load)
fi
args+=("$CONTEXT")
"${args[@]}"
printf 'published image: %s\n' "$IMAGE_REF"

# R2 is an OCI archive/DR copy, not a Docker Registry API endpoint.
if [[ -n "${R2_ARCHIVE_BUCKET:-}" ]]; then
  required R2_ENDPOINT
  command -v skopeo >/dev/null || { printf 'skopeo is required for R2 export\n' >&2; exit 69; }
  command -v aws >/dev/null || { printf 'aws CLI is required for R2 upload\n' >&2; exit 69; }
  tmp="$(mktemp -d)"
  cleanup() { rm -rf "$tmp"; }
  trap cleanup EXIT
  archive="$tmp/image.oci"
  skopeo copy --all "docker://${IMAGE_REF}" "oci-archive:${archive}:${IMAGE_TAG}"
  sha256sum "$archive" >"${archive}.sha256"
  key="${R2_ARCHIVE_PREFIX:-oci}/${IMAGE_NAME}/${IMAGE_TAG}/image.oci"
  aws --endpoint-url "$R2_ENDPOINT" s3 cp "$archive" "s3://${R2_ARCHIVE_BUCKET}/${key}"
  aws --endpoint-url "$R2_ENDPOINT" s3 cp "${archive}.sha256" "s3://${R2_ARCHIVE_BUCKET}/${key}.sha256"
  printf 'archived OCI image to R2: s3://%s/%s\n' "$R2_ARCHIVE_BUCKET" "$key"
fi
