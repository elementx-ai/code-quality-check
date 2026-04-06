import fs from "node:fs/promises";

import {
  isPullRequestEvent,
  resolveChangedFiles,
  resolveGitRoot,
  resolveMergeBase,
} from "./git-changes.js";

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

interface PullRequestRef {
  ref?: string;
  sha?: string;
}

interface PullRequestUser {
  login?: string;
  type?: string;
}

interface PullRequestPayload {
  base?: PullRequestRef;
  body?: string | null;
  head?: PullRequestRef;
  user?: PullRequestUser;
}

interface GitHubEventPayload {
  pull_request?: PullRequestPayload;
}

const isReleasePleaseMetadataFile = (filename: string): boolean =>
  filename === ".release-please-manifest.json" ||
  /(?:^|\/)changelog\.md$/i.test(filename) ||
  /(?:^|\/)package\.json$/i.test(filename) ||
  /(?:^|\/)package-lock\.json$/i.test(filename);

const isBotAuthor = (pullRequest: PullRequestPayload | undefined): boolean => {
  const author = pullRequest?.user?.login ?? "";
  const authorType = pullRequest?.user?.type ?? "";
  return author === "app/github-actions" || authorType === "Bot";
};

const hasReleasePleaseMarker = (
  pullRequest: PullRequestPayload | undefined,
): boolean => {
  const headRef = pullRequest?.head?.ref ?? "";
  const body = pullRequest?.body ?? "";
  return (
    headRef.startsWith("release-please--") ||
    body.includes("This PR was generated with [Release Please]")
  );
};

const resolvePullRequestDiff = (
  pullRequest: PullRequestPayload | undefined,
): { baseSha: string; headSha: string } | undefined => {
  const baseSha = pullRequest?.base?.sha;
  const headSha = pullRequest?.head?.sha;
  if (!baseSha || !headSha) {
    return undefined;
  }

  return { baseSha, headSha };
};

export const isReleasePleasePullRequest = (
  pullRequest: PullRequestPayload | undefined,
): boolean => isBotAuthor(pullRequest) && hasReleasePleaseMarker(pullRequest);

export const isReleasePleaseMetadataOnlyChangeSet = (
  changedFiles: string[],
): boolean => {
  const hasChangelog = changedFiles.some((filename) =>
    /(?:^|\/)changelog\.md$/i.test(filename),
  );
  const hasManifest = changedFiles.includes(".release-please-manifest.json");

  return (
    hasChangelog &&
    hasManifest &&
    changedFiles.length > 0 &&
    changedFiles.every(isReleasePleaseMetadataFile)
  );
};

const readGitHubEventPayload = async (): Promise<
  GitHubEventPayload | undefined
> => {
  if (!isPullRequestEvent()) {
    return undefined;
  }

  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return undefined;
  }

  const raw = await fs.readFile(eventPath, "utf8");
  return JSON.parse(raw) as GitHubEventPayload;
};

export const resolveReleasePleaseMetadataOnlyPrChangedFiles = async (
  workingDirectory: string,
  commandExecutor: ExecCommand,
): Promise<string[] | undefined> => {
  const eventPayload = await readGitHubEventPayload();
  const pullRequest = eventPayload?.pull_request;
  if (!isReleasePleasePullRequest(pullRequest)) {
    return undefined;
  }

  const pullRequestDiff = resolvePullRequestDiff(pullRequest);
  if (!pullRequestDiff) {
    return undefined;
  }

  const gitRoot = await resolveGitRoot(workingDirectory, commandExecutor);
  const mergeBase = await resolveMergeBase(
    gitRoot,
    pullRequestDiff.baseSha,
    pullRequestDiff.headSha,
    commandExecutor,
  );
  const changedFiles = await resolveChangedFiles(
    gitRoot,
    mergeBase,
    pullRequestDiff.headSha,
    commandExecutor,
  );

  if (!isReleasePleaseMetadataOnlyChangeSet(changedFiles)) {
    return undefined;
  }

  return changedFiles;
};
