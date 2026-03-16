#!/usr/bin/env bash
set -euo pipefail

working_directory="${PROJECT_CHECKS_WORKING_DIRECTORY:-.}"

if [[ ! -d "$working_directory" ]]; then
  echo "has_node=false" >> "$GITHUB_OUTPUT"
  echo "has_python=false" >> "$GITHUB_OUTPUT"
  exit 0
fi

find_args=(
  "$working_directory"
  "("
  -name .git
  -o -name node_modules
  -o -name dist
  -o -name build
  -o -name coverage
  -o -name .venv
  -o -name venv
  -o -name .next
  -o -name .nuxt
  -o -name .yarn
  -o -name .pnpm-store
  -o -name out
  -o -name target
  ")"
  -prune
  -o
)

if find "${find_args[@]}" -name package.json -print -quit | grep -q .; then
  echo "has_node=true" >> "$GITHUB_OUTPUT"
else
  echo "has_node=false" >> "$GITHUB_OUTPUT"
fi

if find "${find_args[@]}" -name pyproject.toml -print -quit | grep -q .; then
  echo "has_python=true" >> "$GITHUB_OUTPUT"
else
  echo "has_python=false" >> "$GITHUB_OUTPUT"
fi
