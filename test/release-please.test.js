import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isReleasePleaseMetadataOnlyChangeSet,
  isReleasePleasePullRequest,
  resolveReleasePleaseMetadataOnlyPrChangedFiles,
} from "../src/helpers/release-please.js";

test("isReleasePleasePullRequest detects Release Please bot PRs", () => {
  assert.equal(
    isReleasePleasePullRequest({
      body: "This PR was generated with [Release Please]",
      head: { ref: "release-please--branches--main" },
      user: { login: "app/github-actions", type: "Bot" },
    }),
    true,
  );
  assert.equal(
    isReleasePleasePullRequest({
      body: "",
      head: { ref: "feature/my-branch" },
      user: { login: "octocat", type: "User" },
    }),
    false,
  );
});

test("isReleasePleaseMetadataOnlyChangeSet requires changelog and manifest", () => {
  assert.equal(
    isReleasePleaseMetadataOnlyChangeSet([
      ".release-please-manifest.json",
      "service/CHANGELOG.md",
      "service/package.json",
      "service/package-lock.json",
    ]),
    true,
  );
  assert.equal(
    isReleasePleaseMetadataOnlyChangeSet([
      ".release-please-manifest.json",
      "service/package.json",
    ]),
    false,
  );
  assert.equal(
    isReleasePleaseMetadataOnlyChangeSet([
      ".release-please-manifest.json",
      "service/CHANGELOG.md",
      "src/index.ts",
    ]),
    false,
  );
});

test("resolveReleasePleaseMetadataOnlyPrChangedFiles returns changed files for metadata-only Release Please PRs", async () => {
  const tempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "project-checks-release-please-"),
  );
  const eventPath = path.join(tempDirectory, "event.json");
  const originalEnvironment = {
    GITHUB_EVENT_NAME: process.env.GITHUB_EVENT_NAME,
    GITHUB_EVENT_PATH: process.env.GITHUB_EVENT_PATH,
  };

  try {
    await fs.writeFile(
      eventPath,
      JSON.stringify({
        pull_request: {
          base: { sha: "base-sha" },
          body: "This PR was generated with [Release Please]",
          head: {
            ref: "release-please--branches--main--components--service",
            sha: "head-sha",
          },
          user: { login: "app/github-actions", type: "Bot" },
        },
      }),
    );

    process.env.GITHUB_EVENT_NAME = "pull_request";
    process.env.GITHUB_EVENT_PATH = eventPath;

    const changedFiles = await resolveReleasePleaseMetadataOnlyPrChangedFiles(
      tempDirectory,
      async (commandLine, args, cwd, options) => {
        assert.equal(commandLine, "git");
        assert.equal(cwd, tempDirectory);

        if (args[0] === "rev-parse") {
          options?.stdout?.(Buffer.from(`${tempDirectory}\n`));
          return;
        }

        if (args[0] === "diff") {
          options?.stdout?.(
            Buffer.from(
              [
                ".release-please-manifest.json",
                "service/CHANGELOG.md",
                "service/package.json",
                "service/package-lock.json",
              ].join("\n"),
            ),
          );
          return;
        }

        throw new Error(`Unexpected git command: ${args.join(" ")}`);
      },
    );

    assert.deepEqual(changedFiles, [
      ".release-please-manifest.json",
      "service/CHANGELOG.md",
      "service/package.json",
      "service/package-lock.json",
    ]);
  } finally {
    if (originalEnvironment.GITHUB_EVENT_NAME === undefined) {
      delete process.env.GITHUB_EVENT_NAME;
    } else {
      process.env.GITHUB_EVENT_NAME = originalEnvironment.GITHUB_EVENT_NAME;
    }

    if (originalEnvironment.GITHUB_EVENT_PATH === undefined) {
      delete process.env.GITHUB_EVENT_PATH;
    } else {
      process.env.GITHUB_EVENT_PATH = originalEnvironment.GITHUB_EVENT_PATH;
    }

    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});
