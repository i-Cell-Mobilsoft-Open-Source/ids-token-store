#!/usr/bin/env bash
set -euo pipefail

# Shared entry point for local use, GitHub Actions and GitLab CI/CD.
exec node "$(dirname "$0")/publish-css.mjs"
