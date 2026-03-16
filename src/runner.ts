import * as core from "@actions/core";
import * as exec from "@actions/exec";
import path from "node:path";

import { NodeTargetMetadata, Project, PythonTargetMetadata } from "./types";

const NODE_SCRIPT_ORDER = ["format", "lint", "test", "build"] as const;

export interface RunnerInputs {
  baseRef?: string;
  changedOnly: boolean;
  headRef: string;
  pythonFormatCommand: string;
  pythonLintCommand: string;
  workingDirectory: string;
}

export interface ExecutionSummary {
  changedFiles: string[];
  selectedProjects: Project[];
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
  const changedFiles = await resolveChangedFiles(gitRoot, baseRef, inputs.headRef);
  const selectedProjects = filterProjectsByChanges(projects, gitRoot, changedFiles);

  core.info(
    `Resolved ${changedFiles.length} changed file(s) between ${baseRef} and ${inputs.headRef}.`
  );

  return {
    changedFiles,
    selectedProjects
  };
}

export async function runProjects(
  projects: Project[],
  inputs: RunnerInputs
): Promise<void> {
  for (const project of projects) {
    const ecosystems = project.targets.map((target) => target.ecosystem).join(", ");
    core.startGroup(`Running checks for ${project.relativePath} [${ecosystems}]`);

    try {
      for (const target of project.targets) {
        if (target.ecosystem === "node") {
          await runNodeTarget(project.relativePath, project.rootPath, target.metadata as NodeTargetMetadata);
          continue;
        }

        await runPythonTarget(
          project.relativePath,
          project.rootPath,
          target.metadata as PythonTargetMetadata,
          inputs
        );
      }
    } finally {
      core.endGroup();
    }
  }
}

async function runNodeTarget(
  relativePath: string,
  rootPath: string,
  metadata: NodeTargetMetadata
): Promise<void> {
  for (const scriptName of NODE_SCRIPT_ORDER) {
    if (!(scriptName in metadata.scripts)) {
      core.warning(`${relativePath}: skipping npm run ${scriptName} because the script is not defined.`);
      continue;
    }

    core.info(`${relativePath}: npm run ${scriptName}`);
    await execCommand("npm", ["run", scriptName], rootPath);
  }
}

async function runPythonTarget(
  relativePath: string,
  rootPath: string,
  metadata: PythonTargetMetadata,
  inputs: RunnerInputs
): Promise<void> {
  if (!metadata.hasRuff) {
    core.warning(
      `${relativePath}: skipping Python checks because pyproject.toml does not appear to configure or depend on Ruff.`
    );
    return;
  }

  core.info(`${relativePath}: ${inputs.pythonFormatCommand}`);
  await execConfiguredCommand(inputs.pythonFormatCommand, rootPath);

  core.info(`${relativePath}: ${inputs.pythonLintCommand}`);
  await execConfiguredCommand(inputs.pythonLintCommand, rootPath);
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

async function execConfiguredCommand(commandLine: string, cwd: string): Promise<void> {
  const [tool, ...args] = splitCommandLine(commandLine);
  await execCommand(tool, args, cwd);
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
