# zed-pkg infra — environment secret management.
#
#   just                 # list recipes
#   just use prod        # decrypt env/enc/prod.env.enc and link it to ./.env
#   just edit prod       # edit secrets in place, never touching plaintext on disk
#   just audit           # fail if plaintext could reach a commit
#
# Invariant: plaintext secrets exist only in env/dec/ and the ./.env symlink,
# both gitignored. Only env/enc/*.env.enc is ever committed.

set shell := ["bash", "-euo", "pipefail", "-c"]
set dotenv-load := false

# Exported assignments are evaluated before recipes run. A fresh clone cannot
# contain the ignored empty directory, so create the owner-only plaintext
# boundary before any recipe can access decrypted environment state.
export ZED_ENV_DEC := ```
  set -eu
  root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
  if [ -L "$root/env" ] || [ -L "$root/env/dec" ]; then
    echo "refusing to prepare symlinked env/dec" >&2
    exit 1
  fi
  umask 077
  mkdir -p "$root/env/dec"
  chmod 700 "$root/env/dec"
  printf '%s' "$root/env/dec"
```

enc_dir := justfile_directory() / "env/enc"
dec_dir := justfile_directory() / "env/dec"
age_key := env_var_or_default("SOPS_AGE_KEY_FILE", env_var("HOME") / ".config/sops/age/keys.txt")

_default:
    @just --list --unsorted

# ---------------------------------------------------------------------------
# Environment secrets — delegated to `ores-sops`
#
# ores-sops (github.com/ORESoftware/ores-sops) is the single implementation,
# shared across orgs and supplied by this flake's devShell. These recipes hold
# no logic of their own so there is nothing here to drift.
#
# Anything not listed is plain sops:
#   sops edit env/enc/prod.env.enc          change a secret, no plaintext on disk
#   sops updatekeys env/enc/prod.env.enc    after editing .sops.yaml recipients
#   sops exec-env env/enc/prod.env.enc CMD  run CMD with secrets, no file at all
# ---------------------------------------------------------------------------

# Decrypt <name> and point ./.env at it. The normal daily command.
use name:
    @ores-sops use {{ name }}

# Per-environment state; * marks the active one.
status:
    @ores-sops status

# Edit a secret in place; plaintext never touches disk.
edit name:
    @ores-sops edit {{ name }}

# Fold env/dec/<name>.env edits back into the ciphertext.
encrypt name:
    @ores-sops encrypt {{ name }}

# What local plaintext edits would change.
diff name:
    @ores-sops diff {{ name }}

# Re-decrypt the active env if its ciphertext changed (git hooks call this).
refresh:
    @ores-sops refresh

# Remove decrypted plaintext and the .env symlink.
lock:
    @ores-sops lock

# Print this host's age public key (for onboarding into .sops.yaml).
age-key:
    @age-keygen -y "{{ age_key }}"

# Fail if plaintext secrets could reach a commit. Wire into pre-commit / CI.
audit:
    #!/usr/bin/env bash
    set -euo pipefail
    tracked="$(git ls-files -- '*.env' 'env/dec/*' '.env' 2>/dev/null || true)"
    if [ -n "$tracked" ]; then
        echo "FAIL: plaintext env files are tracked by git:" >&2
        printf '  %s\n' "$tracked" >&2
        exit 1
    fi
    shopt -s nullglob
    for f in env/enc/*.env.enc; do
        grep -q 'ENC\[AES256_GCM' "$f" || { echo "FAIL: $f is not sops-encrypted" >&2; exit 1; }
    done
    echo "audit ok: no plaintext env tracked, all env/enc files encrypted"

# ---------------------------------------------------------------------------
# Cloudflare
# ---------------------------------------------------------------------------

# Verify the zpkg.net zone token in <name>: calls the token verify endpoint and
# reports status. Real I/O — configuration alone never counts as proof.
cf-verify name="prod":
    #!/usr/bin/env bash
    set -euo pipefail
    eval "$(sops -d --input-type dotenv --output-type dotenv "{{ enc_dir }}/{{ name }}.env.enc" | grep -E '^(CLOUDFLARE_API_TOKEN_ZPKG|CLOUDFLARE_ACCOUNT_ID)=')"
    if [[ "$CLOUDFLARE_API_TOKEN_ZPKG" == *PLACEHOLDER* ]]; then
        echo "cf-verify: CLOUDFLARE_API_TOKEN_ZPKG is still a placeholder — mint the real token first (just edit {{ name }})" >&2
        exit 1
    fi
    curl -sf "https://api.cloudflare.com/client/v4/accounts/${CLOUDFLARE_ACCOUNT_ID}/tokens/verify" \
        -H "Authorization: Bearer ${CLOUDFLARE_API_TOKEN_ZPKG}" | jq '{success, status: .result.status}'

# Read live Worker metadata. Does not upload. Token may be PLACEHOLDER — then this fails closed.
cf-snapshot worker:
    node "{{ justfile_directory() }}/workers/scripts/cf-lease.mjs" snapshot --worker {{ worker }}

# Exclusive KV lease. Requires --if-match of the live modified_on from cf-snapshot (or --create-missing).
cf-lease-acquire worker if_match:
    node "{{ justfile_directory() }}/workers/scripts/cf-lease.mjs" acquire --worker {{ worker }} --if-match {{ if_match }}

cf-lease-release worker:
    node "{{ justfile_directory() }}/workers/scripts/cf-lease.mjs" release --worker {{ worker }}

# Acquire → wrangler → release. Fails closed without a real token and matching live modified_on.
# Never wrap this around sonus/fiducia workers — the script allowlist refuses them.
cf-deploy config if_match:
    #!/usr/bin/env bash
    set -euo pipefail
    root="{{ justfile_directory() }}"
    worker="$(python3 -c 'import tomllib,sys; print(tomllib.load(open(sys.argv[1],"rb"))["name"])' "$root/workers/{{ config }}/wrangler.toml")"
    node "$root/workers/scripts/cf-lease.mjs" acquire --worker "$worker" --if-match "{{ if_match }}"
    trap 'node "$root/workers/scripts/cf-lease.mjs" release --worker "$worker" || true' EXIT
    cd "$root/workers" && npx --yes wrangler@4.127.1 deploy --env="" --config "{{ config }}/wrangler.toml"

# Contract tests for the GitHub-fallback URL helpers used by the edge Workers.
workers-test:
    cd "{{ justfile_directory() }}/workers" && npm test
