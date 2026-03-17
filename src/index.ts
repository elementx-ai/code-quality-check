import * as core from "@actions/core";
import path from "node:path";

import { detectRepoMode, discoverProjects } from "./discovery";
import { runProjects, selectProjectsForExecution } from "./runner";

async function main(): Promise<void> {
  const workingDirectory = path.resolve(readStringInput("working-directory", "PROJECT_CHECKS_WORKING_DIRECTORY", "."));
  const autoInstall = readBooleanInput("auto-install", "PROJECT_CHECKS_AUTO_INSTALL", true);
  const includeRoot = readBooleanInput("include-root", "PROJECT_CHECKS_INCLUDE_ROOT", true);
  const projectDepth = readDepthInput("project-depth", "PROJECT_CHECKS_PROJECT_DEPTH");
  const changedOnly = readBooleanInput("changed-only", "PROJECT_CHECKS_CHANGED_ONLY", false);
  const baseRef = readOptionalStringInput("base-ref", "PROJECT_CHECKS_BASE_REF");
  const headRef = readStringInput("head-ref", "PROJECT_CHECKS_HEAD_REF", "HEAD");
  const nodeInstallCommand = readStringInput(
    "node-install-command",
    "PROJECT_CHECKS_NODE_INSTALL_COMMAND",
    "npm ci"
  );
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
  const terraformFormatCommand = readStringInput(
    "terraform-format-command",
    "PROJECT_CHECKS_TERRAFORM_FORMAT_COMMAND",
    "terraform fmt -check -recursive"
  );
  const terraformLintCommand = readStringInput(
    "terraform-lint-command",
    "PROJECT_CHECKS_TERRAFORM_LINT_COMMAND",
    "tflint --recursive"
  );

  core.info(`Scanning ${workingDirectory} for supported projects.`);

  const { projects, misplacedTerraformFiles } = await discoverProjects(workingDirectory, {
    includeRoot,
    projectDepth
  });

  if (misplacedTerraformFiles.length > 0) {
    throw new Error(
      `Terraform files must be placed in a directory named "tf". ` +
        `Found misplaced .tf file(s): ${misplacedTerraformFiles.join(", ")}`
    );
  }

  const repoMode = detectRepoMode(projects);
  const projectPaths = projects.map((project) => project.relativePath);
  const detectedEcosystems = Array.from(
    new Set(projects.flatMap((project) => project.targets.map((target) => target.ecosystem)))
  ).sort();

  core.setOutput("repo_mode", repoMode);
  core.setOutput("project_count", String(projects.length));
  core.setOutput("project_paths", JSON.stringify(projectPaths));
  core.setOutput("detected_ecosystems", JSON.stringify(detectedEcosystems));
  setExecutionOutputs([], [], []);

  if (projects.length === 0) {
    core.info("No supported projects were discovered. Nothing to do.");
    core.setOutput("selected_project_count", "0");
    core.setOutput("selected_project_paths", "[]");
    return;
  }

  core.info(`Discovered ${projects.length} project root(s): ${projectPaths.join(", ")}`);

  const runnerInputs = {
    autoInstall,
    baseRef,
    changedOnly,
    headRef,
    nodeInstallCommand,
    pythonFormatCommand,
    pythonLintCommand,
    terraformFormatCommand,
    terraformLintCommand,
    workingDirectory
  };

  const { selectedProjects } = await selectProjectsForExecution(projects, runnerInputs);
  const selectedProjectPaths = selectedProjects.map((project) => project.relativePath);

  core.setOutput("selected_project_count", String(selectedProjects.length));
  core.setOutput("selected_project_paths", JSON.stringify(selectedProjectPaths));

  if (selectedProjects.length === 0) {
    core.info("No discovered projects matched the current change set.");
    return;
  }

  core.info(`Running checks for ${selectedProjects.length} project root(s).`);
  const runSummary = await runProjects(selectedProjects, runnerInputs);
  setExecutionOutputs(
    runSummary.passedProjectPaths,
    runSummary.failedProjectPaths,
    runSummary.results
  );

  if (runSummary.failedProjectPaths.length > 0) {
    core.setFailed(
      `Checks failed for project(s): ${runSummary.failedProjectPaths.join(", ")}`
    );
  }
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

function readDepthInput(name: string, envName: string): number | undefined {
  const value = readStringInput(name, envName, "-1").trim();
  const parsed = Number.parseInt(value, 10);

  if (Number.isNaN(parsed) || String(parsed) !== value) {
    throw new Error(`Expected ${name} to be an integer, received: ${value}`);
  }

  if (parsed < -1) {
    throw new Error(`Expected ${name} to be -1 or greater, received: ${value}`);
  }

  return parsed === -1 ? undefined : parsed;
}

function setExecutionOutputs(
  passedProjectPaths: string[],
  failedProjectPaths: string[],
  executionResults: unknown[]
): void {
  core.setOutput("passed_project_paths", JSON.stringify(passedProjectPaths));
  core.setOutput("failed_project_paths", JSON.stringify(failedProjectPaths));
  core.setOutput("execution_results", JSON.stringify(executionResults));
}
