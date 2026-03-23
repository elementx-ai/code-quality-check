import * as core from "@actions/core";
import * as exec from "@actions/exec";

import { promises as fs } from "node:fs";
import path from "node:path";

import {
  Ecosystem,
  NodeTargetMetadata,
  Project,
  ProjectTarget,
  PythonTargetMetadata,
} from "./types.js";

const nodeScriptOrder = ["format", "lint", "test", "build"] as const;
const requiredNodeScripts = new Set<string>(["format", "lint"]);
const requiredNodeTools: Record<string, string> = {
  format: "prettier",
  lint: "eslint",
};
const unsupportedShellOperatorPattern = /&&|\|\||[;|]/;

export interface RunnerInputs {
  autoInstall: boolean;
  baseRef?: string;
  changedOnly: boolean;
  headRef: string;
  nodeInstallCommand: string;
  pythonFormatCommand: string;
  pythonLintCommand: string;
  terraformFormatCommand: string;
  terraformLintCommand: string;
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
  options?: ExecOptions,
) => Promise<void>;

interface NodeInstallStep {
  coveredProjectPaths: string[];
  installPath: string;
  label: string;
}

export const selectProjectsForExecution = async (
  projects: Project[],
  inputs: RunnerInputs,
): Promise<ExecutionSummary> => {
  if (!inputs.changedOnly) {
    return {
      changedFiles: [],
      selectedProjects: projects,
    };
  }

  const baseRef = inputs.baseRef || findDefaultBaseRef();
  if (!baseRef) {
    core.warning(
      "changed-only was enabled but no base-ref could be resolved. Running checks for all discovered projects.",
    );

    return {
      changedFiles: [],
      selectedProjects: projects,
    };
  }

  const gitRoot = await resolveGitRoot(inputs.workingDirectory);
  const diffBase = await resolveDiffBase(gitRoot, baseRef, inputs.headRef);
  const changedFiles = await resolveChangedFiles(
    gitRoot,
    diffBase,
    inputs.headRef,
  );
  const selectedProjects = filterProjectsByChanges(
    projects,
    gitRoot,
    changedFiles,
  );

  core.info(
    `Resolved ${changedFiles.length} changed file(s) between ${diffBase} and ${inputs.headRef}.`,
  );

  return {
    changedFiles,
    selectedProjects,
  };
};

const resolveDiffBase = async (
  gitRoot: string,
  baseRef: string,
  headRef: string,
): Promise<string> => {
  if (!isPullRequestEvent()) {
    return baseRef;
  }

  const mergeBase = await resolveMergeBase(gitRoot, baseRef, headRef);
  core.info(`Using merge-base ${mergeBase} for pull request change detection.`);
  return mergeBase;
};

export const runProjects = async (
  projects: Project[],
  inputs: RunnerInputs,
  commandExecutor: CommandExecutor = execCommand,
): Promise<RunProjectsSummary> => {
  const installFailures = await installNodeDependencies(
    projects,
    inputs,
    commandExecutor,
  );
  const results: ProjectExecutionResult[] = [];

  for (const project of projects) {
    const installFailure = installFailures.get(project.relativePath);
    if (installFailure) {
      core.error(`${project.relativePath}: ${installFailure}`);
      results.push({
        ecosystems: project.targets.map((target) => target.ecosystem),
        error: installFailure,
        path: project.relativePath,
        status: "failed",
      });
      continue;
    }

    const ecosystems = project.targets.map((target) => target.ecosystem);
    core.startGroup(
      `Running checks for ${project.relativePath} [${ecosystems.join(", ")}]`,
    );

    try {
      for (const target of project.targets) {
        await runTarget(
          project.relativePath,
          project.rootPath,
          target,
          inputs,
          commandExecutor,
        );
      }
      results.push({
        ecosystems,
        path: project.relativePath,
        status: "passed",
      });
    } catch (error: unknown) {
      const message = formatError(error);
      core.error(`${project.relativePath}: ${message}`);
      results.push({
        ecosystems,
        error: message,
        path: project.relativePath,
        status: "failed",
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
    results,
  };
};

const installNodeDependencies = async (
  projects: Project[],
  inputs: RunnerInputs,
  commandExecutor: CommandExecutor,
): Promise<Map<string, string>> => {
  if (!inputs.autoInstall) {
    return new Map();
  }

  const nodeProjects = projects.filter(projectHasRunnableNodeTarget);
  if (nodeProjects.length === 0) {
    return new Map();
  }

  const steps = await resolveNodeInstallSteps(
    nodeProjects,
    inputs.workingDirectory,
  );
  const failures = new Map<string, string>();

  for (const step of steps) {
    core.startGroup(`Installing Node dependencies for ${step.label}`);

    try {
      core.info(`${step.label}: ${inputs.nodeInstallCommand}`);
      await execConfiguredCommand(
        inputs.nodeInstallCommand,
        step.installPath,
        commandExecutor,
      );
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
};

const resolveNodeInstallSteps = async (
  nodeProjects: Project[],
  workingDirectory: string,
): Promise<NodeInstallStep[]> => {
  if (await shouldUseRootWorkspaceInstall(workingDirectory)) {
    return [
      {
        coveredProjectPaths: nodeProjects.map(
          (project) => project.relativePath,
        ),
        installPath: workingDirectory,
        label: ".",
      },
    ];
  }

  const steps: NodeInstallStep[] = [];

  for (const project of nodeProjects) {
    if (await hasNodeLockfile(project.rootPath)) {
      steps.push({
        coveredProjectPaths: [project.relativePath],
        installPath: project.rootPath,
        label: project.relativePath,
      });
      continue;
    }

    core.info(
      `${project.relativePath}: skipping automatic npm install because no package-lock.json or npm-shrinkwrap.json was found.`,
    );
  }

  return steps;
};

const runTarget = async (
  relativePath: string,
  rootPath: string,
  target: ProjectTarget,
  inputs: RunnerInputs,
  commandExecutor: CommandExecutor,
): Promise<void> => {
  switch (target.ecosystem) {
    case "node":
      return runNodeTarget(
        relativePath,
        rootPath,
        target.metadata,
        commandExecutor,
      );
    case "python":
      return runPythonTarget(
        relativePath,
        rootPath,
        target.metadata,
        inputs,
        commandExecutor,
      );
    case "terraform":
      return runTerraformTarget(
        relativePath,
        rootPath,
        inputs,
        commandExecutor,
      );
    default: {
      const _exhaustive: never = target;
      throw new Error(
        `Unknown ecosystem: ${(_exhaustive as ProjectTarget).ecosystem}`,
      );
    }
  }
};

const projectHasRunnableNodeTarget = (project: Project): boolean =>
  project.targets.some((target) => {
    if (target.ecosystem !== "node") {
      return false;
    }

    for (const scriptName of requiredNodeScripts) {
      if (!(scriptName in target.metadata.scripts)) return false;
    }
    return true;
  });

const runNodeTarget = async (
  relativePath: string,
  rootPath: string,
  metadata: NodeTargetMetadata,
  commandExecutor: CommandExecutor,
): Promise<void> => {
  for (const scriptName of nodeScriptOrder) {
    if (!(scriptName in metadata.scripts)) {
      if (requiredNodeScripts.has(scriptName)) {
        throw new Error(
          `${relativePath}: required script "${scriptName}" is not defined in package.json. ` +
            `All Node projects must define format and lint scripts.`,
        );
      }

      core.info(
        `${relativePath}: skipping npm run ${scriptName} because the script is not defined.`,
      );
      continue;
    }

    const requiredTool = requiredNodeTools[scriptName];
    const scriptValue = metadata.scripts[scriptName];
    if (requiredTool) {
      if (!new RegExp(`\\b${requiredTool}\\b`).test(scriptValue)) {
        throw new Error(
          `${relativePath}: the "${scriptName}" script must use ${requiredTool}, ` +
            `but found: "${scriptValue}"`,
        );
      }
    }

    if (
      scriptName === "format" &&
      unsupportedShellOperatorPattern.test(scriptValue)
    ) {
      core.warning(
        `${relativePath}: only a single prettier command is allowed in the "format" script. Found: "${scriptValue}"`,
      );
      throw new Error(
        `${relativePath}: the "format" script must be a standalone prettier command without shell operators ` +
          `(&&, ||, ;, |). Use a separate script for additional commands and keep CI formatting as prettier --check.`,
      );
    }

    const rewrittenFormatCommand =
      scriptName === "format"
        ? rewritePrettierWriteToCheck(scriptValue, relativePath)
        : undefined;
    if (rewrittenFormatCommand) {
      core.info(
        `${relativePath}: ${rewrittenFormatCommand.commandLine} ${rewrittenFormatCommand.args.join(" ")} ` +
          `(enforced prettier --check arguments)`,
      );
      await commandExecutor(
        "npm",
        [
          "exec",
          "--",
          rewrittenFormatCommand.commandLine,
          ...rewrittenFormatCommand.args,
        ],
        rootPath,
      );
    } else {
      core.info(`${relativePath}: npm run ${scriptName}`);
      await commandExecutor("npm", ["run", scriptName], rootPath);
    }
  }
};

const rewritePrettierWriteToCheck = (
  commandLine: string,
  relativePath: string,
): { args: string[]; commandLine: string } | undefined => {
  let tokens: string[];

  try {
    tokens = splitCommandLine(commandLine);
  } catch (error: unknown) {
    throw new Error(
      `${relativePath}: unable to parse the "format" script for safer prettier rewriting: ${formatError(error)}`,
    );
  }

  if (!tokens.some((token) => /\bprettier\b/.test(token))) {
    return undefined;
  }

  const withoutWriteFlags = tokens.filter((token) => !isPrettierWriteFlag(token));
  const hasCheckEnabled = withoutWriteFlags.some(
    (token) => token === "--check" || token === "--check=true",
  );
  const withoutDisabledCheckFlags = withoutWriteFlags.filter(
    (token) => token !== "--check=false",
  );
  const rewritten =
    hasCheckEnabled && withoutDisabledCheckFlags.length > 0
      ? withoutDisabledCheckFlags
      : [...withoutDisabledCheckFlags, "--check"];
  const wasRewritten = rewritten.join("\u0000") !== tokens.join("\u0000");

  if (!wasRewritten) {
    return undefined;
  }

  const [tool, ...args] = rewritten;
  return {
    args,
    commandLine: tool,
  };
};

const isPrettierWriteFlag = (token: string): boolean =>
  token === "-w" || token === "--write" || token.startsWith("--write=");

const runPythonTarget = async (
  relativePath: string,
  rootPath: string,
  metadata: PythonTargetMetadata,
  inputs: RunnerInputs,
  commandExecutor: CommandExecutor,
): Promise<void> => {
  if (!metadata.hasRuff) {
    core.info(
      `${relativePath}: skipping Python checks because pyproject.toml does not appear to configure or depend on Ruff.`,
    );
    return;
  }

  core.info(`${relativePath}: ${inputs.pythonFormatCommand}`);
  await execConfiguredCommand(
    inputs.pythonFormatCommand,
    rootPath,
    commandExecutor,
  );

  core.info(`${relativePath}: ${inputs.pythonLintCommand}`);
  await execConfiguredCommand(
    inputs.pythonLintCommand,
    rootPath,
    commandExecutor,
  );
};

const runTerraformTarget = async (
  relativePath: string,
  rootPath: string,
  inputs: RunnerInputs,
  commandExecutor: CommandExecutor,
): Promise<void> => {
  core.info(`${relativePath}: ${inputs.terraformFormatCommand}`);
  await execConfiguredCommand(
    inputs.terraformFormatCommand,
    rootPath,
    commandExecutor,
  );

  core.info(`${relativePath}: ${inputs.terraformLintCommand}`);
  await execConfiguredCommand(
    inputs.terraformLintCommand,
    rootPath,
    commandExecutor,
  );
};

const resolveGitRoot = async (workingDirectory: string): Promise<string> => {
  let stdout = "";

  await execCommand("git", ["rev-parse", "--show-toplevel"], workingDirectory, {
    silent: true,
    stdout: (data) => {
      stdout += data.toString();
    },
  });

  return stdout.trim();
};

const resolveChangedFiles = async (
  gitRoot: string,
  baseRef: string,
  headRef: string,
): Promise<string[]> => {
  let stdout = "";

  await execCommand("git", ["diff", "--name-only", baseRef, headRef], gitRoot, {
    silent: true,
    stdout: (data) => {
      stdout += data.toString();
    },
  });

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(path.sep).join(path.posix.sep));
};

const resolveMergeBase = async (
  gitRoot: string,
  baseRef: string,
  headRef: string,
): Promise<string> => {
  let stdout = "";

  try {
    await execCommand("git", ["merge-base", baseRef, headRef], gitRoot, {
      silent: true,
      stdout: (data) => {
        stdout += data.toString();
      },
    });
  } catch (error: unknown) {
    const message = formatError(error);
    throw new Error(
      `Unable to resolve a merge-base for pull request change detection between ${baseRef} and ${headRef}. ` +
        `Ensure both refs are present in the local checkout. Use fetch-depth: 0, and if running under pull_request_target ` +
        `make sure HEAD is the pull request head commit rather than the base branch. Original error: ${message}`,
    );
  }

  return stdout.trim();
};

const filterProjectsByChanges = (
  projects: Project[],
  gitRoot: string,
  changedFiles: string[],
): Project[] =>
  projects.filter((project) => {
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
        changedFile.startsWith(`${relativeToGitRoot}/`),
    );
  });

const findDefaultBaseRef = (): string | undefined => {
  const githubEventBefore = process.env.GITHUB_EVENT_BEFORE;
  if (githubEventBefore && !/^0+$/.test(githubEventBefore)) {
    return githubEventBefore;
  }

  return undefined;
};

const isPullRequestEvent = (): boolean => {
  const eventName = process.env.GITHUB_EVENT_NAME;
  return eventName === "pull_request" || eventName === "pull_request_target";
};

interface ExecOptions {
  silent?: boolean;
  stdout?: (data: Buffer) => void;
}

const execCommand = async (
  commandLine: string,
  args: string[],
  cwd: string,
  options?: ExecOptions,
): Promise<void> => {
  const result = await exec.exec(commandLine, args, {
    cwd,
    ignoreReturnCode: true,
    silent: options?.silent,
    listeners: options?.stdout
      ? {
          stdout: options.stdout,
        }
      : undefined,
  });

  if (result !== 0) {
    throw new Error(
      `Command failed with exit code ${result}: ${[commandLine, ...args].join(" ")}`,
    );
  }
};

const execConfiguredCommand = async (
  commandLine: string,
  cwd: string,
  commandExecutor: CommandExecutor,
): Promise<void> => {
  const [tool, ...args] = splitCommandLine(commandLine);
  await commandExecutor(tool, args, cwd);
};

// eslint-disable-next-line complexity
const splitCommandLine = (commandLine: string): string[] => {
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
};

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};

const shouldUseRootWorkspaceInstall = async (
  workingDirectory: string,
): Promise<boolean> => {
  const packageJsonPath = path.join(workingDirectory, "package.json");
  if (
    !(await pathExists(packageJsonPath)) ||
    !(await hasNodeLockfile(workingDirectory))
  ) {
    return false;
  }

  const packageJson = JSON.parse(
    await fs.readFile(packageJsonPath, "utf8"),
  ) as {
    workspaces?: string[] | { packages?: string[] };
  };

  return hasWorkspaces(packageJson.workspaces);
};

const hasWorkspaces = (
  workspaces: string[] | { packages?: string[] } | undefined,
): boolean => {
  if (Array.isArray(workspaces)) {
    return workspaces.length > 0;
  }

  return Array.isArray(workspaces?.packages) && workspaces.packages.length > 0;
};

const hasNodeLockfile = async (directory: string): Promise<boolean> => {
  if (await pathExists(path.join(directory, "package-lock.json"))) {
    return true;
  }

  return pathExists(path.join(directory, "npm-shrinkwrap.json"));
};

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};
