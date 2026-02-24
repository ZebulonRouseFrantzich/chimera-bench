# Product Mission

## Problem

A repeatable framework is needed to benchmark local LLM runtimes on specific hardware and remote hosts with comparable, reproducible outputs. Current workflows are too ad hoc and make it hard to evolve engine flags, realistic workloads, and deep performance analysis without rewriting tooling.

## Target Users

Initially, this product is for a single power user (the author) who runs and compares local LLM setups, with future support for small teams sharing benchmark artifacts.

## Solution

An OpenCode-inspired split server/client benchmarking platform. A headless Bun/TypeScript server orchestrates runs, exposes an OpenAPI interface, and streams run events to clients. Execution is plugin-based (starting with `llama.cpp`, then expanding to `vLLM` and `exo`), supports both local and SSH targets, and produces structured JSON/CSV/Markdown outputs with sweep and log-derived metrics.
