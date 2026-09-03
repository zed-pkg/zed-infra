#!/usr/bin/env bash
set -euo pipefail

# Environment-only interface avoids leaking credentials through argv.
# Required: REGISTRY_PROVIDER, IMAGE_NAME, IMAGE_TAG.
fail() {
  printf 'error: %s\n' "$*" >&2
  exit 64
}

required() {
  local name="$1"
  if [[ -z "${!name:-}" ]]; then
    fail "missing required environment variable: ${name}"
  fi
}

required REGISTRY_PROVIDER
required IMAGE_NAME
required IMAGE_TAG

DOCKERFILE="${DOCKERFILE:-Dockerfile}"
CONTEXT="${CONTEXT:-.}"
PLATFORMS="${PLATFORMS:-linux/amd64,linux/arm64}"
IMAGE_KIND="${IMAGE_KIND:-portable}"
BUILD_TARGET="${BUILD_TARGET:-}"
BUILD_ARG_NAMES="${BUILD_ARG_NAMES:-}"
PUSH="${PUSH:-true}"
BUILDER_NAME="${BUILDER_NAME:-ores-multiarch}"

case "$PUSH" in
  true | false) ;;
  *) fail 'PUSH must be true or false' ;;
esac

case "$IMAGE_KIND" in
  portable | lambda) ;;
  *) fail 'IMAGE_KIND must be portable or lambda' ;;
esac

[[ "$IMAGE_TAG" =~ ^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$ ]] ||
  fail 'IMAGE_TAG is not a valid OCI tag'
[[ "$IMAGE_NAME" =~ ^[a-z0-9]+([._-][a-z0-9]+)*(\/[a-z0-9]+([._-][a-z0-9]+)*)*$ ]] ||
  fail 'IMAGE_NAME must be a lowercase OCI repository path'
[[ -f "$DOCKERFILE" ]] || fail "Dockerfile does not exist: ${DOCKERFILE}"
[[ -d "$CONTEXT" ]] || fail "build context does not exist: ${CONTEXT}"

IFS=',' read -r -a platform_items <<<"$PLATFORMS"
declare -A seen_platforms=()
for platform in "${platform_items[@]}"; do
  [[ "$platform" == 'linux/amd64' || "$platform" == 'linux/arm64' ]] ||
    fail "unsupported platform: ${platform}"
  [[ -z "${seen_platforms[$platform]:-}" ]] || fail "duplicate platform: ${platform}"
  seen_platforms[$platform]=1
done

if [[ "$IMAGE_KIND" == lambda && ${#platform_items[@]} -ne 1 ]]; then
  fail 'Lambda images must target exactly one platform: linux/amd64 or linux/arm64'
fi
if [[ "$PUSH" == false && ${#platform_items[@]} -ne 1 ]]; then
  fail 'PUSH=false supports exactly one platform because buildx --load cannot load an image index'
fi
if [[ -n "${R2_ARCHIVE_BUCKET:-}" && "$PUSH" != true ]]; then
  fail 'R2 archival requires PUSH=true so the complete published image can be exported'
fi

build_args=()
if [[ -n "$BUILD_ARG_NAMES" ]]; then
  IFS=',' read -r -a names <<<"$BUILD_ARG_NAMES"
  for name in "${names[@]}"; do
    name="${name//[[:space:]]/}"
    [[ -n "$name" ]] || continue
    [[ "$name" =~ ^[A-Z][A-Z0-9_]*$ ]] || fail "invalid build arg name: ${name}"
    required "$name"
    build_args+=(--build-arg "${name}=${!name}")
  done
fi

resolve_registry() {
  case "$REGISTRY_PROVIDER" in
    aws-ecr)
      required REGISTRY_HOST
      required AWS_REGION
      ;;
    dockerhub)
      required DOCKERHUB_USERNAME
      if [[ "$PUSH" == true ]]; then
        required DOCKERHUB_TOKEN
      fi
      REGISTRY_HOST="${REGISTRY_HOST:-docker.io}"
      ;;
    gcp-artifact-registry)
      required REGISTRY_HOST
      ;;
    azure-acr)
      required AZURE_ACR_NAME
      REGISTRY_HOST="${REGISTRY_HOST:-${AZURE_ACR_NAME}.azurecr.io}"
      ;;
    none)
      required REGISTRY_HOST
      ;;
    *) fail "unsupported REGISTRY_PROVIDER: ${REGISTRY_PROVIDER}" ;;
  esac
}

login_registry() {
  [[ "$PUSH" == true ]] || return 0
  case "$REGISTRY_PROVIDER" in
    aws-ecr)
      command -v aws >/dev/null 2>&1 || fail 'aws CLI is required for ECR publication'
      aws ecr get-login-password --region "$AWS_REGION" |
        docker login --username AWS --password-stdin "$REGISTRY_HOST"
      ;;
    dockerhub)
      printf '%s' "$DOCKERHUB_TOKEN" |
        docker login --username "$DOCKERHUB_USERNAME" --password-stdin "$REGISTRY_HOST"
      ;;
    gcp-artifact-registry)
      command -v gcloud >/dev/null 2>&1 || fail 'gcloud CLI is required for Artifact Registry publication'
      gcloud auth print-access-token |
        docker login --username oauth2accesstoken --password-stdin "https://${REGISTRY_HOST}"
      ;;
    azure-acr)
      command -v az >/dev/null 2>&1 || fail 'Azure CLI is required for ACR publication'
      az acr login --name "$AZURE_ACR_NAME"
      ;;
    none) ;;
  esac
}

resolve_registry
REGISTRY_HOST="${REGISTRY_HOST%/}"
IMAGE_NAME="${IMAGE_NAME#/}"
IMAGE_REF="${REGISTRY_HOST}/${IMAGE_NAME}:${IMAGE_TAG}"

command -v docker >/dev/null 2>&1 || fail 'docker with buildx is required'
login_registry

if ! docker buildx inspect "$BUILDER_NAME" >/dev/null 2>&1; then
  docker buildx create --name "$BUILDER_NAME" --driver docker-container --use >/dev/null
else
  docker buildx use "$BUILDER_NAME"
fi
docker buildx inspect --bootstrap >/dev/null

args=(
  docker buildx build
  --file "$DOCKERFILE"
  --platform "$PLATFORMS"
  --tag "$IMAGE_REF"
  --provenance=mode=max
  --sbom=true
)
[[ -z "$BUILD_TARGET" ]] || args+=(--target "$BUILD_TARGET")
args+=("${build_args[@]}")

if [[ "$PUSH" == true ]]; then
  args+=(--push)
else
  args+=(--load)
fi
args+=("$CONTEXT")
"${args[@]}"

if [[ "$PUSH" == true ]]; then
  printf 'published image: %s\n' "$IMAGE_REF"
else
  printf 'built local image: %s\n' "$IMAGE_REF"
fi

# R2 is an OCI archive/DR copy, not a Docker Registry API endpoint.
if [[ -n "${R2_ARCHIVE_BUCKET:-}" ]]; then
  required R2_ENDPOINT
  command -v skopeo >/dev/null 2>&1 || fail 'skopeo is required for R2 export'
  command -v aws >/dev/null 2>&1 || fail 'aws CLI is required for R2 upload'
  tmp="$(mktemp -d)"
  cleanup() {
    find "$tmp" -depth -delete
  }
  trap cleanup EXIT
  archive="$tmp/image.oci.tar"
  checksum="$tmp/image.oci.tar.sha256"
  skopeo copy --all "docker://${IMAGE_REF}" "oci-archive:${archive}:${IMAGE_TAG}"
  digest_line="$(sha256sum "$archive")"
  digest="${digest_line%% *}"
  printf '%s  image.oci.tar\n' "$digest" >"$checksum"
  key="${R2_ARCHIVE_PREFIX:-oci}/${IMAGE_NAME}/${IMAGE_TAG}/image.oci.tar"
  aws --endpoint-url "$R2_ENDPOINT" s3 cp "$archive" "s3://${R2_ARCHIVE_BUCKET}/${key}"
  aws --endpoint-url "$R2_ENDPOINT" s3 cp "$checksum" "s3://${R2_ARCHIVE_BUCKET}/${key}.sha256"
  printf 'archived OCI image to R2: s3://%s/%s\n' "$R2_ARCHIVE_BUCKET" "$key"
fi
