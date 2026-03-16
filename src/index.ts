import * as core from "@actions/core";
import path from "node:path";

import { detectRepoMode, discoverProjects } from "./discovery";
import { runProjects, selectProjectsForExecution } from "./runner";

async function main(): Promise<void> {
  const workingDirectory = path.resolve(readStringInput("working-directory", "PROJECT_CHECKS_WORKING_DIRECTORY", "."));
  const includeRoot = readBooleanInput("include-root", "PROJECT_CHECKS_INCLUDE_ROOT", true);
  const changedOnly = readBooleanInput("changed-only", "PROJECT_CHECKS_CHANGED_ONLY", false);
  const baseRef = readOptionalStringInput("base-ref", "PROJECT_CHECKS_BASE_REF");
  const headRef = readStringInput("head-ref", "PROJECT_CHECKS_HEAD_REF", "HEAD");
  const pythonFormatCommand = readStringInput(
    "python-format-command",
    "PROJECT_CHECKS_PYTHON_FORMAT_COMMAND",
    "uv run ruff format --check ."
  );
  const pythonLintCommand = readStringInput(
    "python-lint-command",
    "PROJECT_CHECKS_PYTHON_LINT_COMMAND",
    "uv run ruff check ."
  );

  core.info(`Scanning ${workingDirectory} for supported projects.`);

  const projects = await discoverProjects(workingDirectory, { includeRoot });
  const repoMode = detectRepoMode(projects);
  const projectPaths = projects.map((project) => project.relativePath);
  const detectedEcosystems = Array.from(
    new Set(projects.flatMap((project) => project.targets.map((target) => target.ecosystem)))
  ).sort();

  core.setOutput("repo_mode", repoMode);
  core.setOutput("project_count", String(projects.length));
  core.setOutput("project_paths", JSON.stringify(projectPaths));
  core.setOutput("detected_ecosystems", JSON.stringify(detectedEcosystems));

  if (projects.length === 0) {
    core.notice("No supported projects were discovered. Nothing to do.");
    core.setOutput("selected_project_count", "0");
    core.setOutput("selected_project_paths", "[]");
    return;
  }

  core.info(`Discovered ${projects.length} project root(s): ${projectPaths.join(", ")}`);

  const { selectedProjects } = await selectProjectsForExecution(projects, {
    baseRef,
    changedOnly,
    headRef,
    pythonFormatCommand,
    pythonLintCommand,
    workingDirectory
  });
  const selectedProjectPaths = selectedProjects.map((project) => project.relativePath);

  core.setOutput("selected_project_count", String(selectedProjects.length));
  core.setOutput("selected_project_paths", JSON.stringify(selectedProjectPaths));

  if (selectedProjects.length === 0) {
    core.notice("No discovered projects matched the current change set.");
    return;
  }

  core.info(`Running checks for ${selectedProjects.length} project root(s).`);
  await runProjects(selectedProjects, {
    baseRef,
    changedOnly,
    headRef,
    pythonFormatCommand,
    pythonLintCommand,
    workingDirectory
  });
}

main().catch((error: unknown) => {
  if (error instanceof Error) {
    core.setFailed(error.message);
    return;
  }

  core.setFailed(String(error));
});

function readStringInput(name: string, envName: string, fallback: string): string {
  const envValue = process.env[envName];
  if (envValue !== undefined && envValue !== "") {
    return envValue;
  }

  const actionInput = core.getInput(name);
  if (actionInput) {
    return actionInput;
  }

  return fallback;
}

function readOptionalStringInput(name: string, envName: string): string | undefined {
  const value = readStringInput(name, envName, "");
  return value || undefined;
}

function readBooleanInput(name: string, envName: string, fallback: boolean): boolean {
  const envValue = process.env[envName];
  if (envValue !== undefined && envValue !== "") {
    return parseBoolean(envValue, envName);
  }

  const inputValue = core.getInput(name);
  if (inputValue) {
    return parseBoolean(inputValue, name);
  }

  return fallback;
}

function parseBoolean(value: string, label: string): boolean {
  const normalized = value.trim().toLowerCase();

  if (normalized === "true") {
    return true;
  }

  if (normalized === "false") {
    return false;
  }

  throw new Error(`Expected ${label} to be true or false, received: ${value}`);
}
