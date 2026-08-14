{
  description = "zed-pkg infra — environment secrets (ores-sops) for zpkg.net and Supabase";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixpkgs-unstable";
    flake-utils.url = "github:numtide/flake-utils";

    # The env-secret tooling is org-agnostic and lives in its own repo, so every
    # zed-pkg repo shares one implementation rather than a copied justfile.
    ores-sops.url = "github:ORESoftware/ores-sops";
  };

  outputs = { self, nixpkgs, flake-utils, ores-sops }:
    flake-utils.lib.eachDefaultSystem (system:
      let
        pkgs = import nixpkgs {
          inherit system;
          overlays = [ ores-sops.overlays.default ];
        };
      in
      {
        devShells.default = pkgs.mkShell {
          name = "zed-infra";
          packages = with pkgs; [
            # Qualified deliberately: `with pkgs;` does not shadow the outputs
            # function's arguments, so a bare `ores-sops` here resolves to the
            # flake INPUT (an attrset) rather than the package, and nix fails
            # with "Dependency is not of a valid type".
            pkgs.ores-sops
            sops
            age
            just
            curl # Cloudflare REST calls (token verify)
            jq
            git

            # k8s manifests in this repo; terraform is intentionally absent
            # (unfree license would force allowUnfree on every consumer) —
            # bring your own, per README prerequisites.
            kubectl
            kustomize
          ];

          shellHook = ores-sops.lib.shellHook + ''
            # Keep this local guard until the flake lock advances to the
            # ores-sops release that includes lib.prepareEnvDec.
            _repo_root="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
            if [ -L "$_repo_root/env" ] || [ -L "$_repo_root/env/dec" ]; then
              echo "env: refusing to prepare symlinked env/dec" >&2
              return 1 2>/dev/null || exit 1
            fi
            umask 077
            mkdir -p "$_repo_root/env/dec"
            chmod 700 "$_repo_root/env/dec"
            unset _repo_root
          '';
        };
      });
}
