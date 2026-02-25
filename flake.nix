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
            echo "Entering chimera-bench dev shell"
            echo "Run 'just --list' to see developer commands."
            export CHIMERA_BENCH_DEV=1
          '';
        };
      }
    );
}
