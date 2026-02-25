set shell := ["bash", "-euo", "pipefail", "-c"]
nix_cmd := "nix --extra-experimental-features \"nix-command flakes\""

default:
    @just --list

fmt:
    {{nix_cmd}} fmt flake.nix

check:
    {{nix_cmd}} flake check

shell:
    {{nix_cmd}} develop

install:
    @if [ -f package.json ]; then \
      bun install; \
    else \
      echo "No package.json yet; install is a placeholder until app scaffolding lands."; \
    fi

lint:
    @echo "Placeholder: add scripts.lint in package.json, then update this recipe."

test:
    @echo "Placeholder: add tests/package scripts, then update this recipe."

serve:
    @echo "Placeholder: add runtime entrypoint, then update this recipe."
