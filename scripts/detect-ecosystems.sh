#!/usr/bin/env bash
set -euo pipefail

working_directory="${PROJECT_CHECKS_WORKING_DIRECTORY:-.}"

# Keep these outputs in sync with the detection outputs below.
if [[ ! -d "$working_directory" ]]; then
  echo "has_node=false" >> "$GITHUB_OUTPUT"
  echo "has_python=false" >> "$GITHUB_OUTPUT"
  echo "has_terraform=false" >> "$GITHUB_OUTPUT"
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

# Check if any tf or module directory contains .tf files
has_terraform=false
for dir_name in tf module; do
  if [[ "$has_terraform" == "true" ]]; then
    break
  fi
  while IFS= read -r tf_dir; do
    if find "$tf_dir" -maxdepth 1 -name '*.tf' -print -quit | grep -q .; then
      has_terraform=true
      break
    fi
  done < <(find "${find_args[@]}" -type d -name "$dir_name" -print 2>/dev/null)
done
echo "has_terraform=$has_terraform" >> "$GITHUB_OUTPUT"
