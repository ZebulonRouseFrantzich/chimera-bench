{
  description = "chimera-bench local development environment";

  inputs = {
    nixpkgs.url = "github:NixOS/nixpkgs/nixos-unstable";
    flake-utils.url = "github:numtide/flake-utils";
  };

  outputs =
    {
      self,
      nixpkgs,
      flake-utils,
    }:
    flake-utils.lib.eachDefaultSystem (
      system:
      let
        pkgs = nixpkgs.legacyPackages.${system};
      in
      {
        formatter = pkgs.nixfmt;

        devShells.default = pkgs.mkShell {
          packages = with pkgs; [
            bun
            nodejs
            typescript
            typescript-language-server
            just
            direnv
            nix-direnv
            git
            jq
            ripgrep
            fd
            curl
          ];

          shellHook = ''
            REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || pwd)"
            export CHIMERA_BENCH_DEV_BIN="$REPO_ROOT/bin/chimera-bench"
            export CHIMERA_BENCH_RELEASE_BIN="$HOME/.chimera-bench/bin/chimera-bench"
            export JUST_UNSORTED=true

            export PATH="$REPO_ROOT/bin:$PATH"
            hash -r 2>/dev/null || true

            echo ""
            echo "----------------------------------- DEV INFO -------------------------------------"
            echo "Entering chimera-bench dev shell"
            echo ""
            echo "'just' commands:"
            just --list
            echo "Run 'just --list' to see developer commands again."
            echo ""
            echo "Binary override:"
            echo "  chimera-bench         -> $CHIMERA_BENCH_DEV_BIN (dev)"
            if [ -x "$CHIMERA_BENCH_RELEASE_BIN" ]; then
              echo "  chimera-bench-release -> $REPO_ROOT/bin/chimera-bench-release (wrapper -> $CHIMERA_BENCH_RELEASE_BIN)"
            else
              echo "  chimera-bench-release -> $REPO_ROOT/bin/chimera-bench-release (wrapper -> $CHIMERA_BENCH_RELEASE_BIN, release not installed)"
            fi
            echo "----------------------------------- DEV INFO -------------------------------------"
            echo ""
          '';
        };
      }
    );
}
