set shell := ["bash", "-euo", "pipefail", "-c"]
nix_cmd := "nix --extra-experimental-features \"nix-command flakes\""

# Show all available developer commands.
default:
    @just --list --unsorted

# Install project dependencies.
install:
    @if [ -f package.json ]; then \
      bun install; \
    else \
      echo "No package.json yet; install is a placeholder until app scaffolding lands."; \
    fi

# Start the local dev server via the repo CLI entrypoint.
serve *args:
    @if [ -f package.json ]; then \
      set -- {{args}}; \
      if [ "${1:-}" = "--" ]; then shift; fi; \
      exec ./bin/chimera-bench serve "$@"; \
    else \
      echo "No package.json yet; serve is a placeholder until app scaffolding lands."; \
    fi

# Run the test suite.
test:
    @if [ -f package.json ]; then \
      bun run test; \
    else \
      echo "No package.json yet; test is a placeholder until app scaffolding lands."; \
    fi

# Run lint and source quality checks.
lint:
    @if [ -f package.json ]; then \
      bun run lint; \
    else \
      echo "No package.json yet; lint is a placeholder until app scaffolding lands."; \
    fi

# Build a host-native compiled binary for local smoke tests.
build: install
    @if [ -f package.json ]; then \
      bun run ./scripts/build-local-binary.ts; \
    else \
      echo "No package.json yet; build is a placeholder until app scaffolding lands."; \
    fi

# Build all release artifacts (multi-platform binaries + checksums).
build-release: install
    @if [ -f package.json ]; then \
      bun run release:build; \
    else \
      echo "No package.json yet; build-release is a placeholder until app scaffolding lands."; \
    fi

# Run target profile commands via the repo CLI entrypoint.
targets *args:
    @if [ -f package.json ]; then \
      set -- {{args}}; \
      if [ "${1:-}" = "--" ]; then shift; fi; \
      exec ./bin/chimera-bench targets "$@"; \
    else \
      echo "No package.json yet; targets is a placeholder until app scaffolding lands."; \
    fi

# Enter the Nix development shell.
shell:
    {{nix_cmd}} develop

# Run flake checks.
check:
    {{nix_cmd}} flake check

# Format Nix files.
fmt:
    {{nix_cmd}} fmt flake.nix
