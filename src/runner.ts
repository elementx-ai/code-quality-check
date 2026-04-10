import * as core from "@actions/core";

import {
  filterProjectsByChanges,
  findDefaultBaseRef,
  isPullRequestEvent,
  resolveChangedFiles,
  resolveFirstParent,
  resolveGitRoot,
  resolveMergeBase,
} from "./helpers/git-changes.js";
import {
  ExecOptions,
  execCommand as sharedExecCommand,
} from "./helpers/exec.js";
import {
  hasNodeLockfile,
  shouldUseRootWorkspaceInstall,
} from "./helpers/node-install.js";
import { normalizePrettierFormatScript } from "./helpers/node-format.js";
import {
  hasUnquotedShellOperatorToken,
  splitCommandLine,
} from "./helpers/command-line.js";
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

  const gitRoot = await resolveGitRoot(inputs.workingDirectory, execCommand);
  const diffBase = await resolveDiffBase(gitRoot, baseRef, inputs.headRef);
  const changedFiles = await resolveChangedFiles(
    gitRoot,
    diffBase,
    inputs.headRef,
    execCommand,
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

  const firstParent = await resolveFirstParent(gitRoot, headRef, execCommand);
  if (firstParent) {
    core.info(
      `HEAD is a merge commit. Using first parent ${firstParent} as diff base for pull request change detection.`,
    );
    return firstParent;
  }

  const mergeBase = await resolveMergeBase(
    gitRoot,
    baseRef,
    headRef,
    execCommand,
  );
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

    if (scriptName === "format" && hasUnquotedShellOperatorToken(scriptValue)) {
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
        ? normalizePrettierFormatScript(scriptValue, relativePath)
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

const execCommand = async (
  commandLine: string,
  args: string[],
  cwd: string,
  options?: ExecOptions,
): Promise<void> => {
  await sharedExecCommand(commandLine, args, cwd, {
    rewrapExitCode: true,
    silent: options?.silent,
    stdout: options?.stdout,
  });
};

const execConfiguredCommand = async (
  commandLine: string,
  cwd: string,
  commandExecutor: CommandExecutor,
): Promise<void> => {
  const [tool, ...args] = splitCommandLine(commandLine);
  await commandExecutor(tool, args, cwd);
};

const formatError = (error: unknown): string => {
  if (error instanceof Error) {
    return error.message;
  }

  return String(error);
};
