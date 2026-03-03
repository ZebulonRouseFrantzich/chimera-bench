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
    @if [ -f package.json ]; then \
      bun run lint; \
    else \
      echo "No package.json yet; lint is a placeholder until app scaffolding lands."; \
    fi

test:
    @if [ -f package.json ]; then \
      bun run test; \
    else \
      echo "No package.json yet; test is a placeholder until app scaffolding lands."; \
    fi

serve *args:
    @if [ -f package.json ]; then \
      set -- {{args}}; \
      if [ "${1:-}" = "--" ]; then shift; fi; \
      exec ./bin/chimera-bench serve "$@"; \
    else \
      echo "No package.json yet; serve is a placeholder until app scaffolding lands."; \
    fi

targets *args:
    @if [ -f package.json ]; then \
      set -- {{args}}; \
      if [ "${1:-}" = "--" ]; then shift; fi; \
      exec ./bin/chimera-bench targets "$@"; \
    else \
      echo "No package.json yet; targets is a placeholder until app scaffolding lands."; \
    fi
