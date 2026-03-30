import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";

// Keep this workflow guard aligned with src/helpers/release-please.ts.

const outputPath = process.env.GITHUB_OUTPUT;
const workingDirectory = process.env.GITHUB_WORKSPACE || process.cwd();

const setOutput = (name, value) => {
  if (!outputPath) {
    return;
  }

  fs.appendFileSync(outputPath, `${name}=${value}\n`);
};

const readEventPayload = () => {
  const eventPath = process.env.GITHUB_EVENT_PATH;
  if (!eventPath) {
    return undefined;
  }

  return JSON.parse(fs.readFileSync(eventPath, "utf8"));
};

const runGit = (args, cwd) =>
  execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

const isBotAuthor = (pullRequest) => {
  const author = pullRequest?.user?.login ?? "";
  const authorType = pullRequest?.user?.type ?? "";
  return author === "app/github-actions" || authorType === "Bot";
};

const hasReleasePleaseMarker = (pullRequest) => {
  const headRef = pullRequest?.head?.ref ?? "";
  const body = pullRequest?.body ?? "";
  return (
    headRef.startsWith("release-please--") ||
    body.includes("This PR was generated with [Release Please]")
  );
};

const isReleasePleasePullRequest = (pullRequest) =>
  isBotAuthor(pullRequest) && hasReleasePleaseMarker(pullRequest);

const resolvePullRequestDiff = (pullRequest) => {
  const baseSha = pullRequest?.base?.sha;
  const headSha = pullRequest?.head?.sha;

  if (!baseSha || !headSha) {
    return undefined;
  }

  return { baseSha, headSha };
};

const isReleasePleaseMetadataOnlyChangeSet = (changedFiles) => {
  const hasChangelog = changedFiles.some((filename) =>
    /(?:^|\/)changelog\.md$/i.test(filename),
  );
  const hasManifest = changedFiles.includes(".release-please-manifest.json");

  return (
    hasChangelog &&
    hasManifest &&
    changedFiles.length > 0 &&
    changedFiles.every(
      (filename) =>
        filename === ".release-please-manifest.json" ||
        /(?:^|\/)changelog\.md$/i.test(filename) ||
        /(?:^|\/)package\.json$/i.test(filename) ||
        /(?:^|\/)package-lock\.json$/i.test(filename),
    )
  );
};

setOutput("skip", "false");

try {
  const pullRequest = readEventPayload()?.pull_request;
  if (!isReleasePleasePullRequest(pullRequest)) {
    process.exit(0);
  }

  const pullRequestDiff = resolvePullRequestDiff(pullRequest);
  if (!pullRequestDiff) {
    process.exit(0);
  }

  const gitRoot = runGit(["rev-parse", "--show-toplevel"], workingDirectory);
  const mergeBase = runGit(
    ["merge-base", pullRequestDiff.baseSha, pullRequestDiff.headSha],
    gitRoot,
  );
  const changedFiles = runGit(
    ["diff", "--name-only", mergeBase, pullRequestDiff.headSha],
    gitRoot,
  )
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(path.sep).join(path.posix.sep));

  console.log(
    `release-please PR changed files: ${changedFiles.join(", ") || "(none)"}`,
  );

  if (isReleasePleaseMetadataOnlyChangeSet(changedFiles)) {
    setOutput("skip", "true");
  }
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  console.warn(
    `Unable to evaluate Release Please PR skip logic; defaulting to running build-and-test. ${message}`,
  );
  setOutput("skip", "false");
}
