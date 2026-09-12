#!/usr/bin/env python3
"""Harden and pin the public-intake Cloudflare edge contract."""

from __future__ import annotations

import json
import os
import re
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
INTERFACES_REV = "ed9b3b67fe24741dd96db0490e80d95cf37d1a4f"
CORE_REV = os.environ["ZED_LIB_CORE_REV"]
API_REV = os.environ["ZED_API_SERVER_REV"]
WEB_REV = os.environ["ZED_WEB_SERVER_REV"]


def immutable(value: str, name: str) -> str:
    if re.fullmatch(r"[0-9a-f]{40}", value) is None:
        raise RuntimeError(f"{name} is not an immutable commit SHA")
    return value


def harden_org_origin() -> None:
    variables = ROOT / "terraform/cloudflare/variables.tf"
    text = variables.read_text()
    if 'variable "org_origin_hostname"' not in text:
        text = text.rstrip() + '''

variable "org_origin_hostname" {
  description = "Verified hostname used as the proxied CNAME origin for org.zpkg.net when provision_org_host is enabled"
  type        = string
  default     = ""

  validation {
    condition = var.org_origin_hostname == "" || (
      can(regex("^[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$", var.org_origin_hostname)) &&
      !can(regex("^https?://", var.org_origin_hostname))
    )
    error_message = "org_origin_hostname must be a hostname without a URL scheme."
  }
}
'''
    variables.write_text(text)

    main = ROOT / "terraform/cloudflare/main.tf"
    text = main.read_text()
    start = text.find('resource "cloudflare_dns_record" "org"')
    if start < 0:
        raise RuntimeError("organization DNS resource is missing")
    end = text.find('\nresource "', start + 1)
    if end < 0:
        end = len(text)
    block = text[start:end]
    block = re.sub(r'(?m)^\s*type\s*=\s*"A"\s*$', '  type       = "CNAME"', block)
    block = re.sub(
        r'(?m)^\s*content\s*=\s*"192\.0\.2\.1"\s*$',
        '  content    = var.org_origin_hostname',
        block,
    )
    if 'type       = "CNAME"' not in block or 'content    = var.org_origin_hostname' not in block:
        raise RuntimeError("organization DNS resource does not use the verified CNAME origin")
    text = text[:start] + block + text[end:]
    if 'check "public_intake_org_origin"' not in text:
        text = text.rstrip() + '''

check "public_intake_org_origin" {
  assert {
    condition = !var.provision_org_host || (
      length(trimspace(var.org_origin_hostname)) > 0 &&
      lower(trimspace(var.org_origin_hostname)) != "org.${lower(var.zone_name)}"
    )
    error_message = "provision_org_host requires a verified non-self-referential org_origin_hostname; placeholder origins are forbidden."
  }
}
'''
    main.write_text(text)

    example = ROOT / "terraform/cloudflare/terraform.tfvars.example"
    text = example.read_text()
    if "org_origin_hostname" not in text:
        text = text.rstrip() + '''

# Keep false until the organization origin has passed outside-in probes.
provision_org_host = false
# org_origin_hostname = "web-origin.example.net"
'''
    example.write_text(text)

    docs = ROOT / "docs/public-intake-edge.md"
    if docs.exists():
        text = docs.read_text()
        text = text.replace(
            "A proxied TEST-NET placeholder is used only to attach the Worker route.",
            "The organization host uses an explicitly supplied, verified proxied CNAME origin; TEST-NET and self-referential placeholders are forbidden.",
        )
        if "## Organization origin gate" not in text:
            text += '''

## Organization origin gate

`provision_org_host` remains false until `org_origin_hostname` names a verified origin that can safely receive unmatched `org.zpkg.net` paths. Terraform rejects an empty, URL-shaped, or self-referential origin when provisioning is enabled. The Worker intercepts only the exact quote route family.
'''
        docs.write_text(text)


def write_provenance() -> None:
    document = {
        "schema": "zed.public-intake.promotion.v1",
        "interfaces": {"repository": "zed-pkg/zed-interfaces", "commit": INTERFACES_REV},
        "persistence": {"repository": "zed-pkg/zed-lib-core", "commit": CORE_REV},
        "api": {"repository": "zed-pkg/zed-api-server.rs", "commit": API_REV},
        "webOrigin": {"repository": "zed-pkg/zed-web-server.rs", "commit": WEB_REV},
        "edgeRoutes": [
            {"host": "user.zpkg.net", "pathPrefix": "/pre-interest"},
            {"host": "org.zpkg.net", "pathPrefix": "/quote"},
        ],
        "apiRoutes": ["/v1/pre-interest", "/v1/quote-requests"],
        "deploymentStatus": "source-certified-not-activated",
    }
    path = ROOT / "docs/public-intake-promotion.json"
    path.write_text(json.dumps(document, indent=2, sort_keys=True) + "\n")


def write_permanent_ci() -> None:
    path = ROOT / ".github/workflows/public-intake-cross-repo-contract.yml"
    path.write_text(
        f'''name: public intake cross-repository contract

on:
  pull_request:
    paths:
      - "workers/public-intake/**"
      - "terraform/cloudflare/**"
      - "docs/public-intake-*.md"
      - "docs/public-intake-promotion.json"
      - ".github/workflows/public-intake-cross-repo-contract.yml"
  push:
    branches: [main]
    paths:
      - "workers/public-intake/**"
      - "terraform/cloudflare/**"
      - "docs/public-intake-*.md"
      - "docs/public-intake-promotion.json"
      - ".github/workflows/public-intake-cross-repo-contract.yml"

permissions:
  contents: read

concurrency:
  group: public-intake-cross-repo-${{{{ github.workflow }}}}-${{{{ github.ref }}}}
  cancel-in-progress: true

jobs:
  public-intake-cross-repo:
    runs-on: ubuntu-24.04
    timeout-minutes: 45
    steps:
      - name: Check out edge
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          path: zed-infra
          persist-credentials: false
          show-progress: false

      - name: Check out immutable interfaces
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          repository: zed-pkg/zed-interfaces
          ref: {INTERFACES_REV}
          path: zed-interfaces
          persist-credentials: false
          show-progress: false

      - name: Check out immutable persistence
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          repository: zed-pkg/zed-lib-core
          ref: {CORE_REV}
          path: zed-lib-core
          persist-credentials: false
          show-progress: false

      - name: Check out immutable API
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          repository: zed-pkg/zed-api-server.rs
          ref: {API_REV}
          path: zed-api-server
          persist-credentials: false
          show-progress: false

      - name: Check out immutable web origin
        uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4
        with:
          repository: zed-pkg/zed-web-server.rs
          ref: {WEB_REV}
          path: zed-web-server
          persist-credentials: false
          show-progress: false

      - name: Install Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v6
        with:
          node-version: "22"
          package-manager-cache: false

      - name: Install Nix
        uses: cachix/install-nix-action@630ae543ea3a38a9a4166f03376c02c50f408342
        with:
          extra_nix_config: |
            experimental-features = nix-command flakes

      - name: Verify Worker and Terraform contract
        working-directory: zed-infra
        run: |
          set -euo pipefail
          npm ci --prefix workers --ignore-scripts --no-audit --no-fund
          npm test --prefix workers
          nix develop --no-update-lock-file -c terraform -chdir=terraform/cloudflare fmt -check
          nix develop --no-update-lock-file -c terraform -chdir=terraform/cloudflare init -backend=false
          nix develop --no-update-lock-file -c terraform -chdir=terraform/cloudflare validate
          ! grep -R -n --fixed-strings '192.0.2.1' terraform/cloudflare docs/public-intake-edge.md

      - name: Verify immutable cross-repository route and trust envelope
        run: |
          set -euo pipefail
          grep -R -q '/v1/pre-interest' zed-interfaces/src zed-api-server/src/routes/public_intake.rs
          grep -R -q '/v1/quote-requests' zed-interfaces/src zed-api-server/src/routes/public_intake.rs
          grep -R -q 'x-zed-intake-body-sha256' zed-infra/workers/public-intake zed-api-server/src/routes/public_intake.rs
          grep -R -q 'x-zed-intake-signature' zed-infra/workers/public-intake zed-api-server/src/routes/public_intake.rs
          grep -R -q 'x-zed-intake-source-host' zed-infra/workers/public-intake zed-api-server/src/routes/public_intake.rs
          grep -R -q 'user.zpkg.net' zed-web-server/k8s zed-infra/workers/public-intake
          grep -q 'source-certified-not-activated' zed-infra/docs/public-intake-promotion.json
          test -s zed-lib-core/src/rust-orm/sql/2026-09-02-public-intake.sql
          test -s zed-lib-core/src/rust-orm/public_intake.rs
          test -s zed-api-server/.github/workflows/public-intake-api-contract.yml
          test -s zed-lib-core/.github/workflows/public-intake-persistence-contract.yml

      - name: Verify no credential material was committed
        run: |
          set -euo pipefail
          for repository in zed-infra zed-interfaces zed-lib-core zed-api-server zed-web-server; do
            if git -C "$repository" grep -nE '(ghp_|github_pat_|lin_api_)[A-Za-z0-9_]+' -- .; then
              echo "credential-shaped material found in $repository" >&2
              exit 1
            fi
          done
'''
    )


def main() -> None:
    immutable(INTERFACES_REV, "interfaces revision")
    immutable(CORE_REV, "persistence revision")
    immutable(API_REV, "API revision")
    immutable(WEB_REV, "web revision")
    harden_org_origin()
    write_provenance()
    write_permanent_ci()


if __name__ == "__main__":
    main()
