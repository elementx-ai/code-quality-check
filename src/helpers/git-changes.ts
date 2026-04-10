import path from "node:path";

import { Project } from "../types.js";

interface ExecOptions {
  silent?: boolean;
  stdout?: (data: Buffer) => void;
}

type ExecCommand = (
  commandLine: string,
  args: string[],
  cwd: string,
  options?: ExecOptions,
) => Promise<void>;

const formatError = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export const resolveGitRoot = async (
  workingDirectory: string,
  commandExecutor: ExecCommand,
): Promise<string> => {
  let stdout = "";

  await commandExecutor(
    "git",
    ["rev-parse", "--show-toplevel"],
    workingDirectory,
    {
      silent: true,
      stdout: (data) => {
        stdout += data.toString();
      },
    },
  );

  return stdout.trim();
};

export const resolveChangedFiles = async (
  gitRoot: string,
  baseRef: string,
  headRef: string,
  commandExecutor: ExecCommand,
): Promise<string[]> => {
  let stdout = "";

  await commandExecutor(
    "git",
    ["diff", "--name-only", baseRef, headRef],
    gitRoot,
    {
      silent: true,
      stdout: (data) => {
        stdout += data.toString();
      },
    },
  );

  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(path.sep).join(path.posix.sep));
};

export const resolveMergeBase = async (
  gitRoot: string,
  baseRef: string,
  headRef: string,
  commandExecutor: ExecCommand,
): Promise<string> => {
  let stdout = "";

  try {
    await commandExecutor("git", ["merge-base", baseRef, headRef], gitRoot, {
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

export const filterProjectsByChanges = (
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

export const findDefaultBaseRef = (): string | undefined => {
  const githubEventBefore = process.env.GITHUB_EVENT_BEFORE;
  if (githubEventBefore && !/^0+$/.test(githubEventBefore)) {
    return githubEventBefore;
  }

  return undefined;
};

export const isPullRequestEvent = (): boolean => {
  const eventName = process.env.GITHUB_EVENT_NAME;
  return eventName === "pull_request" || eventName === "pull_request_target";
};

export const resolveFirstParent = async (
  gitRoot: string,
  ref: string,
  commandExecutor: ExecCommand,
): Promise<string | undefined> => {
  let stdout = "";

  try {
    await commandExecutor(
      "git",
      ["rev-parse", "--verify", `${ref}^2`],
      gitRoot,
      {
        silent: true,
        stdout: (data) => {
          stdout += data.toString();
        },
      },
    );
  } catch {
    return undefined;
  }

  if (!stdout.trim()) {
    return undefined;
  }

  let firstParent = "";

  await commandExecutor("git", ["rev-parse", "--verify", `${ref}^1`], gitRoot, {
    silent: true,
    stdout: (data) => {
      firstParent += data.toString();
    },
  });

  return firstParent.trim() || undefined;
};
