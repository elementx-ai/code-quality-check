# Code Quality Check Action

This repository contains a reusable GitHub Action that checks out a repository, sets up the required toolchains, discovers runnable projects, and executes standard checks for each one.

Current support:

- Node projects detected by `package.json`
- Python projects detected by `pyproject.toml`

Behavior:

- Single-project repo: runs checks for the one discovered project
- Multi-project repo: runs checks for every discovered project root
- Release Please pull requests are skipped when the PR only changes `.release-please-manifest.json`, `CHANGELOG.md`, `package.json`, and `package-lock.json`, and both the manifest and a changelog are present in the diff
- Optional changed-only mode: limits execution to project roots with changed files
  - on pull requests, changed files are calculated from the git merge-base to avoid selecting projects changed only on the base branch
  - on pushes, changed files are calculated from the previous pushed commit to `HEAD`
  - changed-only requires both comparison refs to exist in the local checkout, so keep `fetch-depth: 0`
  - for `pull_request_target`, `HEAD` is usually the base branch unless you explicitly check out the pull request head commit

Node checks:

- `npm run format`
- `npm run lint`
- `npm run test`
- `npm run build`

`format` and `lint` are required scripts for Node projects.

Format-script enforcement:

- `format` must be a standalone Prettier command (no shell operators such as `&&`, `||`, `;`, `|`)
- when format enforcement is needed, the command must invoke `prettier` directly (wrapper commands like `npx prettier ...` or `cross-env ... prettier ...` are rejected)
- if `format` is not already in check mode, the action rewrites it to check mode by removing `--write` variants and enforcing `--check`
- rewritten format commands are executed with `npm exec -- prettier ...` so local tool resolution still happens through npm

`test` and `build` remain optional. Missing optional scripts are logged and do not fail the action.

Node configuration enforcement:

- every Node project must have a `.nvmrc` pinning a numeric Node version of at least `22` (for example `22`, `v24`, or `24.1.0`); nvm aliases such as `lts/*`, `lts/jod`, `node`, or `stable` are rejected because they cannot be statically guaranteed to meet the minimum
- a Node version of `22` or `23` is allowed but emits a warning: the recommended minimum is `24`
- every Node project must have a `.npmrc` setting `min-release-age` to at least `3` (days), which delays installing newly published package versions as a supply-chain safeguard (requires npm v11.10+)
- both files are resolved from the project directory upward to the repository root, so a single root `.nvmrc` and `.npmrc` cover every package in a monorepo
- a missing or invalid `.nvmrc` or `.npmrc` fails the action
- the check honors `changed-only`: a project is validated when it has changed files, so adding the config counts as the change that brings the project into compliance

Python checks:

- `uv run ruff format --check .`
- `uv run ruff check .`

Python checks only run when the action detects Ruff usage in `pyproject.toml`. Otherwise the action emits a warning and continues.

Python configuration enforcement:

- every Python project must configure a dependency cooldown of at least `3` days, which delays resolving newly published package versions as a supply-chain safeguard. The required setting depends on the project's package manager, which the action detects from `pyproject.toml` (`[tool.uv]` / `[tool.poetry]` / `poetry-core` build backend) and from `uv.toml`, `uv.lock`, `poetry.toml`, or `poetry.lock`
- uv projects set [`exclude-newer`](https://docs.astral.sh/uv/concepts/resolution/#dependency-cooldowns) to a duration under `[tool.uv]` in `pyproject.toml` or in `uv.toml`. The duration may be a friendly value (`"3 days"`, `"72 hours"`, `"1 week"`) or an ISO 8601 duration (`"P3D"`, `"PT72H"`); an absolute date is rejected because it is a fixed pin rather than a rolling cooldown. Duration-based cooldowns require uv `0.11.5`+
- poetry projects set [`min-release-age`](https://python-poetry.org/docs/configuration/#solvermin-release-age) to an integer number of days under `[solver]` in `poetry.toml` (for example `poetry config --local solver.min-release-age 3`)
- when a project uses both managers, configuring either cooldown satisfies the check
- the setting is resolved from the project directory upward to the repository root so a workspace root config covers every member
- a missing, too-short, or invalid cooldown fails the action, and the check honors `changed-only` the same way as the Node checks
- every Python project must have a `.python-version` pinning a numeric Python version of at least `3.13` (for example `3.14` or `3.14.1`); aliases such as `pypy3.10` are rejected because they cannot be statically guaranteed to meet the minimum. A missing or invalid `.python-version` fails the action
- a Python version of `3.13` is allowed but emits a warning: the recommended minimum is `3.14`
- when `requires-python` is present in `[project]` of `pyproject.toml`, its lower bound is validated the same way: a floor below `3.13` fails the action and a floor of `3.13` emits a warning
- the `.python-version` file is resolved from the project directory upward to the repository root, so a single root pin covers every package in a monorepo

Claude plugin naming enforcement:

- every `.claude-plugin/plugin.json` and `.claude-plugin/marketplace.json` found anywhere in the repository (excluding `node_modules`, `dist`, and other build directories) is validated for proper naming
- each plugin must set a human-readable `displayName` in Title Case (for example `"Proposal Hub"`). Without it, the Claude Code `/plugin` picker, the marketplace listing, and the connector UI fall back to the kebab-case `name`. `displayName` requires Claude Code v2.1.143+
- a `displayName` is rejected when it is missing or empty, contains an underscore, or is not Title Case (each word must start with a capital letter or digit; common lowercase connector words such as `of`, `the`, and `and` are allowed after the first word)
- each plugin `name` (in `plugin.json` and every entry of `marketplace.json`'s `plugins` array) must be a kebab-case identifier (lowercase letters, digits, and hyphens), since it is the programmatic id used for installation and tool namespacing
- each key under `plugin.json`'s `mcpServers` object must be a kebab-case identifier (lowercase letters, digits, and hyphens). MCP server entries have no display-name field, so the key is shown verbatim as the connector chip in the `/plugin` UI and also prefixes the MCP tool namespace (`mcp__<key>__<tool>`); a key with spaces, underscores, or capitals (for example `"Proposal Hub"`) produces an ugly connector label and tool ids
- `marketplace.json`'s top-level `name` must be a kebab-case identifier: it is the public marketplace id users type in `/plugin install <plugin>@<marketplace>`
- `marketplace.json` has no recognized top-level `displayName` field, so one set there is silently ignored by Claude Code. The check flags a top-level `displayName` and points you to set it on each `plugins` entry instead (a missing per-entry `displayName` falls back to the kebab-case `name`, not to the plugin's own `plugin.json`)
- this is a repository-wide policy gate: it runs regardless of project discovery or `changed-only`, so a non-compliant manifest fails the action

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
- `python-version`: default `3.14`
- `uv-version`: optional
- `changed-only`: default `true`
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
