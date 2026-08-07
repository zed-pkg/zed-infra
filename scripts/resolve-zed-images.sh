#!/usr/bin/env bash
set -euo pipefail

: "${ZED_API_REF:?ZED_API_REF is required}"
: "${ZED_WEB_REF:?ZED_WEB_REF is required}"
: "${ZED_INTERFACES_REF:?ZED_INTERFACES_REF is required}"
: "${ZED_GHCR_USERNAME:?ZED_GHCR_USERNAME is required}"
: "${ZED_GHCR_TOKEN:?ZED_GHCR_TOKEN is required}"

api_repo="${ZED_API_IMAGE_REPO:-ghcr.io/zed-pkg/zed-api-server}"
web_repo="${ZED_WEB_IMAGE_REPO:-ghcr.io/zed-pkg/zed-web-server}"
postgres_repo="${ZED_POSTGRES_IMAGE_REPO:-pgvector/pgvector}"
postgres_tag_name="${ZED_POSTGRES_TAG:-0.8.5-pg16}"
api_tag="${api_repo}:${ZED_API_REF}"
web_tag="${web_repo}:${ZED_WEB_REF}"
postgres_tag="${postgres_repo}:${postgres_tag_name}"
evidence="${ZED_IMAGE_EVIDENCE:-${RUNNER_TEMP:-/tmp}/zed-image-provenance.txt}"
docker_config="$(mktemp -d "${RUNNER_TEMP:-/tmp}/zed-docker.XXXXXX")"
work="$(mktemp -d "${RUNNER_TEMP:-/tmp}/zed-images.XXXXXX")"

cleanup() {
  rm -rf "$docker_config" "$work"
}
trap cleanup EXIT HUP INT TERM

if [[ -n "${GITHUB_ACTIONS:-}" ]]; then
  printf '::add-mask::%s\n' "$ZED_GHCR_TOKEN"
fi

if ! printf '%s' "$ZED_GHCR_TOKEN" | \
  DOCKER_CONFIG="$docker_config" docker login ghcr.io \
    --username "$ZED_GHCR_USERNAME" --password-stdin >/dev/null 2>&1; then
  echo 'GHCR authentication failed while resolving deployable images' >&2
  exit 2
fi

pull_with_retry() {
  local image=$1
  local attempt
  for attempt in $(seq 1 18); do
    if DOCKER_CONFIG="$docker_config" docker pull "$image" >/dev/null 2>&1; then
      return 0
    fi
    if ((attempt == 18)); then
      echo "image did not become readable after 18 attempts: $image" >&2
      return 1
    fi
    sleep 10
  done
}

pull_with_retry "$api_tag"
pull_with_retry "$web_tag"
pull_with_retry "$postgres_tag"
DOCKER_CONFIG="$docker_config" docker image inspect "$api_tag" > "$work/api.json"
DOCKER_CONFIG="$docker_config" docker image inspect "$web_tag" > "$work/web.json"
DOCKER_CONFIG="$docker_config" docker image inspect "$postgres_tag" > "$work/postgres.json"

python3 - "$work/api.json" "$work/web.json" "$work/postgres.json" \
  "$api_repo" "$web_repo" "$postgres_repo" \
  "$ZED_API_REF" "$ZED_WEB_REF" "$ZED_INTERFACES_REF" \
  "$postgres_tag_name" "$evidence" <<'PY'
import json
import pathlib
import sys

(
    api_path,
    web_path,
    postgres_path,
    api_repo,
    web_repo,
    postgres_repo,
    api_ref,
    web_ref,
    interfaces_ref,
    postgres_tag,
    evidence_path,
) = sys.argv[1:]


def load_one(path: str, kind: str) -> dict:
    values = json.loads(pathlib.Path(path).read_text(encoding="utf-8"))
    if len(values) != 1:
        raise SystemExit(f"expected one {kind} image inspection, got {len(values)}")
    value = values[0]
    if value.get("Architecture") != "amd64" or value.get("Os") != "linux":
        raise SystemExit(
            f"{kind} image must be linux/amd64, got {value.get('Os')}/{value.get('Architecture')}"
        )
    return value


def unique_digest(value: dict, repo: str, kind: str) -> str:
    matches = []
    for item in value.get("RepoDigests", []):
        name, separator, digest = item.partition("@")
        if not separator or not digest.startswith("sha256:"):
            continue
        if name == repo or name.endswith("/" + repo):
            matches.append(item)
    matches = sorted(set(matches))
    if len(matches) != 1:
        raise SystemExit(f"{kind} image has no unique digest for {repo}: {matches!r}")
    return matches[0]


def validate_zed(path: str, repo: str, source_ref: str, kind: str) -> str:
    value = load_one(path, kind)
    labels = value.get("Config", {}).get("Labels") or {}
    revision = labels.get("org.opencontainers.image.revision")
    interface_revision = labels.get("io.zpkg.interfaces.revision")
    if revision != source_ref:
        raise SystemExit(
            f"{kind} image revision label mismatch: expected {source_ref}, got {revision}"
        )
    if interface_revision != interfaces_ref:
        raise SystemExit(
            f"{kind} interfaces label mismatch: expected {interfaces_ref}, got {interface_revision}"
        )
    return unique_digest(value, repo, kind)


api_digest = validate_zed(api_path, api_repo, api_ref, "api")
web_digest = validate_zed(web_path, web_repo, web_ref, "web")
postgres_digest = unique_digest(load_one(postgres_path, "postgres"), postgres_repo, "postgres")

path = pathlib.Path(evidence_path)
path.parent.mkdir(parents=True, exist_ok=True)
path.write_text(
    "\n".join(
        [
            f"api_source_revision={api_ref}",
            f"api_image={api_digest}",
            f"web_source_revision={web_ref}",
            f"web_image={web_digest}",
            f"interfaces_revision={interfaces_ref}",
            f"postgres_tag={postgres_repo}:{postgres_tag}",
            f"postgres_image={postgres_digest}",
            "platform=linux/amd64",
            "",
        ]
    ),
    encoding="utf-8",
)
print(f"ZED_API_IMAGE={api_digest}")
print(f"ZED_WEB_IMAGE={web_digest}")
print(f"ZED_POSTGRES_IMAGE={postgres_digest}")
PY

api_image="$(sed -n 's/^api_image=//p' "$evidence")"
web_image="$(sed -n 's/^web_image=//p' "$evidence")"
postgres_image="$(sed -n 's/^postgres_image=//p' "$evidence")"
[[ "$api_image" == "$api_repo@sha256:"* ]]
[[ "$web_image" == "$web_repo@sha256:"* ]]
[[ "$postgres_image" == "$postgres_repo@sha256:"* || "$postgres_image" == "docker.io/$postgres_repo@sha256:"* ]]

if [[ -n "${GITHUB_ENV:-}" ]]; then
  printf 'ZED_API_IMAGE=%s\nZED_WEB_IMAGE=%s\nZED_POSTGRES_IMAGE=%s\n' \
    "$api_image" "$web_image" "$postgres_image" >> "$GITHUB_ENV"
fi

printf 'resolved immutable images: api=%s web=%s postgres=%s\n' \
  "$api_image" "$web_image" "$postgres_image"
