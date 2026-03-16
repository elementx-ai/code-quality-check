# Project Checks Action

This repository contains a reusable GitHub Action that checks out a repository, sets up the required toolchains, discovers runnable projects, and executes standard checks for each one.

Current support:

- Node projects detected by `package.json`
- Python projects detected by `pyproject.toml`

Behavior:

- Single-project repo: runs checks for the one discovered project
- Multi-project repo: runs checks for every discovered project root
- Optional changed-only mode: limits execution to project roots with changed files

Node checks:

- `npm run format`
- `npm run lint`
- `npm run test`
- `npm run build`

Each Node script is only run if it exists in `package.json`. Missing scripts emit a warning and do not fail the action.

Python checks:

- `uv run ruff format --check .`
- `uv run ruff check .`

Python checks only run when the action detects Ruff usage in `pyproject.toml`. Otherwise the action emits a warning and continues.

## Usage

Minimal usage:

```yaml
name: CI

on:
  pull_request:
  push:
    branches: [main]

jobs:
  checks:
    runs-on: ubuntu-latest
    steps:
      - uses: elementx-ai/code-quality-check@main
        with:
          changed-only: true
          base-ref: ${{ github.event.pull_request.base.sha || github.event.before }}
```

What the action handles internally:

- `actions/checkout@v6`
- `actions/setup-node@v6` when a `package.json` is detected
- `actions/setup-python@v6` and `astral-sh/setup-uv@v7` when a `pyproject.toml` is detected

Important constraint:

- this action sets up toolchains, but it does not install project dependencies for you
- Node projects still need their dependencies available before `npm run lint` or similar scripts can succeed
- Python projects still need a usable `uv` project configuration

If you want, the next iteration can add an optional install phase with repo-specific heuristics.

Useful inputs:

- `checkout`: default `true`
- `fetch-depth`: default `0`
- `auto-setup`: default `true`
- `node-version`: default `24`
- `python-version`: default `3.12`
- `uv-version`: optional
- `changed-only`: default `false`
- `base-ref`: optional
- `head-ref`: default `HEAD`

## Outputs

- `repo_mode`
- `project_count`
- `selected_project_count`
- `project_paths`
- `selected_project_paths`
- `detected_ecosystems`

## Local development

```bash
npm install
npm test
npm run build
```

## Releases

This repo includes Release Please. On pushes to `main`, it opens or updates a release PR. When that PR is merged, Release Please creates the Git tag and GitHub release automatically.
