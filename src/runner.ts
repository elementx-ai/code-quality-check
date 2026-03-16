import * as core from "@actions/core";
import * as exec from "@actions/exec";
import { promises as fs } from "node:fs";
import path from "node:path";

import { Ecosystem, NodeTargetMetadata, Project, PythonTargetMetadata } from "./types";

const NODE_SCRIPT_ORDER = ["format", "lint", "test", "build"] as const;

export interface RunnerInputs {
  autoInstall: boolean;
  baseRef?: string;
  changedOnly: boolean;
  headRef: string;
  nodeInstallCommand: string;
  pythonFormatCommand: string;
  pythonLintCommand: string;
  workingDirectory: string;
}

export interface ExecutionSummary {
  changedFiles: string[];
  selectedProjects: Project[];
}

export interface ProjectExecutionResult {
  error?: string;
  ecosystems: Ecosystem[];
  path: string;
  status: "failed" | "passed";
}

export interface RunProjectsSummary {
  failedProjectPaths: string[];
  passedProjectPaths: string[];
  results: ProjectExecutionResult[];
}

type CommandExecutor = (
  commandLine: string,
  args: string[],
  cwd: string,
  options?: ExecOptions
) => Promise<void>;

interface NodeInstallStep {
  coveredProjectPaths: string[];
  installPath: string;
  label: string;
}

export async function selectProjectsForExecution(
  projects: Project[],
  inputs: RunnerInputs
): Promise<ExecutionSummary> {
  if (!inputs.changedOnly) {
    return {
      changedFiles: [],
      selectedProjects: projects
    };
  }

  const baseRef = inputs.baseRef || findDefaultBaseRef();
  if (!baseRef) {
    core.warning(
      "changed-only was enabled but no base-ref could be resolved. Running checks for all discovered projects."
    );

    return {
      changedFiles: [],
      selectedProjects: projects
    };
  }

  const gitRoot = await resolveGitRoot(inputs.workingDirectory);
  const diffBase = await resolveDiffBase(gitRoot, baseRef, inputs.headRef);
  const changedFiles = await resolveChangedFiles(gitRoot, diffBase, inputs.headRef);
  const selectedProjects = filterProjectsByChanges(projects, gitRoot, changedFiles);

  core.info(
    `Resolved ${changedFiles.length} changed file(s) between ${diffBase} and ${inputs.headRef}.`
  );

  return {
    changedFiles,
    selectedProjects
  };
}

async function resolveDiffBase(
  gitRoot: string,
  baseRef: string,
  headRef: string
): Promise<string> {
  if (!isPullRequestEvent()) {
    return baseRef;
  }

  const mergeBase = await resolveMergeBase(gitRoot, baseRef, headRef);
  core.info(`Using merge-base ${mergeBase} for pull request change detection.`);
  return mergeBase;
}

export async function runProjects(
  projects: Project[],
  inputs: RunnerInputs,
  commandExecutor: CommandExecutor = execCommand
): Promise<RunProjectsSummary> {
  const installFailures = await installNodeDependencies(projects, inputs, commandExecutor);
  const results: ProjectExecutionResult[] = [];

  for (const project of projects) {
    const installFailure = installFailures.get(project.relativePath);
    if (installFailure) {
      core.error(`${project.relativePath}: ${installFailure}`);
      results.push({
        ecosystems: project.targets.map((target) => target.ecosystem),
        error: installFailure,
        path: project.relativePath,
        status: "failed"
      });
      continue;
    }

    const ecosystems = project.targets.map((target) => target.ecosystem);
    core.startGroup(`Running checks for ${project.relativePath} [${ecosystems.join(", ")}]`);

    try {
      for (const target of project.targets) {
        if (target.ecosystem === "node") {
          await runNodeTarget(
            project.relativePath,
            project.rootPath,
            target.metadata as NodeTargetMetadata,
            commandExecutor
          );
          continue;
        }

        await runPythonTarget(
          project.relativePath,
          project.rootPath,
          target.metadata as PythonTargetMetadata,
          inputs,
          commandExecutor
        );
      }
      results.push({
        ecosystems,
        path: project.relativePath,
        status: "passed"
      });
    } catch (error: unknown) {
      const message = formatError(error);
      core.error(`${project.relativePath}: ${message}`);
      results.push({
        ecosystems,
        error: message,
        path: project.relativePath,
        status: "failed"
      });
    } finally {
      core.endGroup();
    }
  }

  return {
    failedProjectPaths: results
      .filter((result) => result.status === "failed")
      .map((result) => result.path),
    passedProjectPaths: results
      .filter((result) => result.status === "passed")
      .map((result) => result.path),
    results
  };
}

async function installNodeDependencies(
  projects: Project[],
  inputs: RunnerInputs,
  commandExecutor: CommandExecutor
): Promise<Map<string, string>> {
  if (!inputs.autoInstall) {
    return new Map();
  }

  const nodeProjects = projects.filter(projectHasRunnableNodeTarget);
  if (nodeProjects.length === 0) {
    return new Map();
  }

  const steps = await resolveNodeInstallSteps(nodeProjects, inputs.workingDirectory);
  const failures = new Map<string, string>();

  for (const step of steps) {
    core.startGroup(`Installing Node dependencies for ${step.label}`);

    try {
      core.info(`${step.label}: ${inputs.nodeInstallCommand}`);
      await execConfiguredCommand(inputs.nodeInstallCommand, step.installPath, commandExecutor);
    } catch (error: unknown) {
      const message = `Dependency install failed: ${formatError(error)}`;
      core.error(`${step.label}: ${message}`);

      for (const projectPath of step.coveredProjectPaths) {
        failures.set(projectPath, message);
      }
    } finally {
      core.endGroup();
    }
  }

  return failures;
}

async function resolveNodeInstallSteps(
  nodeProjects: Project[],
  workingDirectory: string
): Promise<NodeInstallStep[]> {
  if (await shouldUseRootWorkspaceInstall(workingDirectory)) {
    return [
      {
        coveredProjectPaths: nodeProjects.map((project) => project.relativePath),
        installPath: workingDirectory,
        label: "."
      }
    ];
  }

  const steps: NodeInstallStep[] = [];

  for (const project of nodeProjects) {
    if (await hasNodeLockfile(project.rootPath)) {
      steps.push({
        coveredProjectPaths: [project.relativePath],
        installPath: project.rootPath,
        label: project.relativePath
      });
      continue;
    }

    core.warning(
      `${project.relativePath}: skipping automatic npm install because no package-lock.json or npm-shrinkwrap.json was found.`
    );
  }

  return steps;
}

function projectHasRunnableNodeTarget(project: Project): boolean {
  return project.targets.some((target) => {
    if (target.ecosystem !== "node") {
      return false;
    }

    const metadata = target.metadata as NodeTargetMetadata;
    return NODE_SCRIPT_ORDER.some((scriptName) => scriptName in metadata.scripts);
  });
}

async function runNodeTarget(
  relativePath: string,
  rootPath: string,
  metadata: NodeTargetMetadata,
  commandExecutor: CommandExecutor
): Promise<void> {
  for (const scriptName of NODE_SCRIPT_ORDER) {
    if (!(scriptName in metadata.scripts)) {
      core.warning(`${relativePath}: skipping npm run ${scriptName} because the script is not defined.`);
      continue;
    }

    core.info(`${relativePath}: npm run ${scriptName}`);
    await commandExecutor("npm", ["run", scriptName], rootPath);
  }
}

async function runPythonTarget(
  relativePath: string,
  rootPath: string,
  metadata: PythonTargetMetadata,
  inputs: RunnerInputs,
  commandExecutor: CommandExecutor
): Promise<void> {
  if (!metadata.hasRuff) {
    core.warning(
      `${relativePath}: skipping Python checks because pyproject.toml does not appear to configure or depend on Ruff.`
    );
    return;
  }

  core.info(`${relativePath}: ${inputs.pythonFormatCommand}`);
  await execConfiguredCommand(inputs.pythonFormatCommand, rootPath, commandExecutor);

  core.info(`${relativePath}: ${inputs.pythonLintCommand}`);
  await execConfiguredCommand(inputs.pythonLintCommand, rootPath, commandExecutor);
}

async function resolveGitRoot(workingDirectory: string): Promise<string> {
  let stdout = "";

  await execCommand("git", ["rev-parse", "--show-toplevel"], workingDirectory, {
    silent: true,
    stdout: (data) => {
      stdout += data.toString();
    }
  });

  return stdout.trim();
}

async function resolveChangedFiles(
  gitRoot: string,
  baseRef: string,
  headRef: string
): Promise<string[]> {
  let stdout = "";

  await execCommand("git", ["diff", "--name-only", baseRef, headRef], gitRoot, {
    silent: true,
    stdout: (data) => {
      stdout += data.toString();
    }
  });

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(path.sep).join(path.posix.sep));
}

async function resolveMergeBase(
  gitRoot: string,
  baseRef: string,
  headRef: string
): Promise<string> {
  let stdout = "";

  await execCommand("git", ["merge-base", baseRef, headRef], gitRoot, {
    silent: true,
    stdout: (data) => {
      stdout += data.toString();
    }
  });

  return stdout.trim();
}

function filterProjectsByChanges(
  projects: Project[],
  gitRoot: string,
  changedFiles: string[]
): Project[] {
  return projects.filter((project) => {
    const relativeToGitRoot = path
      .relative(gitRoot, project.rootPath)
      .split(path.sep)
      .join(path.posix.sep);

    if (!relativeToGitRoot) {
      return changedFiles.length > 0;
    }

    return changedFiles.some(
      (changedFile) =>
        changedFile === relativeToGitRoot ||
        changedFile.startsWith(`${relativeToGitRoot}/`)
    );
  });
}

function findDefaultBaseRef(): string | undefined {
  const githubEventBefore = process.env.GITHUB_EVENT_BEFORE;
  if (githubEventBefore && !/^0+$/.test(githubEventBefore)) {
    return githubEventBefore;
  }

  return undefined;
}

function isPullRequestEvent(): boolean {
  const eventName = process.env.GITHUB_EVENT_NAME;
  return eventName === "pull_request" || eventName === "pull_request_target";
}

interface ExecOptions {
  silent?: boolean;
  stdout?: (data: Buffer) => void;
}

async function execCommand(
  commandLine: string,
  args: string[],
  cwd: string,
  options?: ExecOptions
): Promise<void> {
  const result = await exec.exec(commandLine, args, {
    cwd,
    ignoreReturnCode: true,
    silent: options?.silent,
    listeners: options?.stdout
      ? {
          stdout: options.stdout
        }
      : undefined
  });

  if (result !== 0) {
    throw new Error(`Command failed with exit code ${result}: ${[commandLine, ...args].join(" ")}`);
  }
}

async function execConfiguredCommand(
  commandLine: string,
  cwd: string,
  commandExecutor: CommandExecutor
): Promise<void> {
  const [tool, ...args] = splitCommandLine(commandLine);
  await commandExecutor(tool, args, cwd);
}

function splitCommandLine(commandLine: string): string[] {
  const tokens: string[] = [];
  let currentToken = "";
  let quote: '"' | "'" | null = null;
  let escaping = false;

  for (const character of commandLine.trim()) {
    if (escaping) {
      currentToken += character;
      escaping = false;
      continue;
    }

    if (character === "\\" && quote !== "'") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (character === quote) {
        quote = null;
      } else {
        currentToken += character;
      }

      continue;
    }

    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }

    if (/\s/.test(character)) {
      if (currentToken) {
        tokens.push(currentToken);
        currentToken = "";
      }

      continue;
    }

    currentToken += character;
  }

  if (escaping || quote) {
    throw new Error(`Unable to parse command: ${commandLine}`);
  }

  if (currentToken) {
    tokens.push(currentToken);
  }

  if (tokens.length === 0) {
    throw new Error("Configured command was empty.");
  }

  return tokens;
}

function formatError(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
}

async function shouldUseRootWorkspaceInstall(workingDirectory: string): Promise<boolean> {
  const packageJsonPath = path.join(workingDirectory, "package.json");
  if (!(await pathExists(packageJsonPath)) || !(await hasNodeLockfile(workingDirectory))) {
    return false;
  }

  const packageJson = JSON.parse(await fs.readFile(packageJsonPath, "utf8")) as {
    workspaces?: string[] | { packages?: string[] };
  };

  return hasWorkspaces(packageJson.workspaces);
}

function hasWorkspaces(workspaces: string[] | { packages?: string[] } | undefined): boolean {
  if (Array.isArray(workspaces)) {
    return workspaces.length > 0;
  }

  return Array.isArray(workspaces?.packages) && workspaces.packages.length > 0;
}

async function hasNodeLockfile(directory: string): Promise<boolean> {
  return (
    (await pathExists(path.join(directory, "package-lock.json"))) ||
    (await pathExists(path.join(directory, "npm-shrinkwrap.json")))
  );
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}
