# Project Checks Action

This repository contains a reusable GitHub Action that checks out a repository, sets up the required toolchains, discovers runnable projects, and executes standard checks for each one.

Current support:

- Node projects detected by `package.json`
- Python projects detected by `pyproject.toml`

Behavior:

- Single-project repo: runs checks for the one discovered project
- Multi-project repo: runs checks for every discovered project root
- Optional changed-only mode: limits execution to project roots with changed files
  - on pull requests, changed files are calculated from the git merge-base to avoid selecting projects changed only on the base branch
  - on pull requests, the action checks out `github.event.pull_request.head.sha` itself so `HEAD` is the actual PR head commit instead of GitHub's synthetic merge ref
  - on pushes, changed files are calculated from the previous pushed commit to `HEAD`
  - changed-only requires both comparison refs to exist in the local checkout, so keep `fetch-depth: 0`
  - for `pull_request_target`, `HEAD` is usually the base branch unless you explicitly check out the pull request head commit

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

If you use `pull_request_target`, do your own checkout first so `HEAD` points at the PR head commit:

```yaml
      - uses: actions/checkout@v6
        with:
          ref: ${{ github.event.pull_request.head.sha }}
          fetch-depth: 0

      - uses: elementx-ai/code-quality-check@main
        with:
          checkout: false
          changed-only: true
          base-ref: ${{ github.event.pull_request.base.sha }}
```

Depth control:

- `project-depth: 0` means only the working directory itself is considered
- `project-depth: 1` means the working directory plus direct child folders
- `project-depth: -1` means unlimited depth and preserves the current broad discovery behavior

What the action handles internally:

- `actions/checkout@v6`
- `actions/setup-node@v6` when a `package.json` is detected
- `actions/setup-python@v6` and `astral-sh/setup-uv@v7` when a `pyproject.toml` is detected
- automatic Node dependency installation with `npm ci` when a lockfile can be resolved

Node install behavior:

- if the repo root is an npm workspace with a root lockfile, it runs one root `npm ci`
- otherwise, it runs `npm ci` inside each selected Node project that has its own lockfile
- if no `package-lock.json` or `npm-shrinkwrap.json` is available for a selected Node project, the action warns and continues

Important constraint:

- Python projects still need a usable `uv` project configuration

If you want, the next iteration can add an optional install phase with repo-specific heuristics.

Useful inputs:

- `checkout`: default `true`
- `fetch-depth`: default `0`
- `auto-setup`: default `true`
- `auto-install`: default `true`
- `project-depth`: default `-1`
- `node-version`: default `24`
- `node-install-command`: default `npm ci`
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
- `passed_project_paths`
- `failed_project_paths`
- `execution_results`

`passed_project_paths` and `failed_project_paths` are JSON arrays, so downstream workflows can query them with `fromJSON(...)`.

Example:

```yaml
      - id: quality
        uses: elementx-ai/code-quality-check@main
        with:
          changed-only: true
          base-ref: ${{ github.event.pull_request.base.sha || github.event.before }}

      - name: React to evaluator failure
        if: ${{ contains(fromJSON(steps.quality.outputs.failed_project_paths), 'evaluator') }}
        run: echo "evaluator failed quality checks"
```

## Local development

```bash
npm install
npm test
npm run build
```

## Releases

This repo includes Release Please. On pushes to `main`, it opens or updates a release PR. When that PR is merged, Release Please creates the Git tag and GitHub release automatically.
