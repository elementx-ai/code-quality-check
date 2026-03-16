const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runProjects, selectProjectsForExecution } = require("../lib/runner.js");

test("runProjects returns passed and failed project paths", async () => {
  const calls = [];
  const projects = [
    {
      rootPath: "/tmp/evaluator",
      relativePath: "evaluator",
      targets: [
        {
          ecosystem: "node",
          manifestPath: "/tmp/evaluator/package.json",
          metadata: {
            scripts: {
              format: "prettier .",
              lint: "eslint ."
            }
          }
        }
      ]
    },
    {
      rootPath: "/tmp/api",
      relativePath: "api",
      targets: [
        {
          ecosystem: "python",
          manifestPath: "/tmp/api/pyproject.toml",
          metadata: {
            hasRuff: true
          }
        }
      ]
    }
  ];

  async function commandExecutor(commandLine, args, cwd) {
    calls.push({ args, commandLine, cwd });

    if (cwd === "/tmp/evaluator" && args[1] === "lint") {
      throw new Error("lint failed");
    }
  }

  const summary = await runProjects(
    projects,
    {
      autoInstall: false,
      changedOnly: false,
      headRef: "HEAD",
      nodeInstallCommand: "npm ci",
      pythonFormatCommand: "uv run ruff format --check .",
      pythonLintCommand: "uv run ruff check .",
      workingDirectory: "/tmp"
    },
    commandExecutor
  );

  assert.deepEqual(summary.passedProjectPaths, ["api"]);
  assert.deepEqual(summary.failedProjectPaths, ["evaluator"]);
  assert.deepEqual(summary.results, [
    {
      ecosystems: ["node"],
      error: "lint failed",
      path: "evaluator",
      status: "failed"
    },
    {
      ecosystems: ["python"],
      path: "api",
      status: "passed"
    }
  ]);
  assert.deepEqual(calls, [
    {
      args: ["run", "format"],
      commandLine: "npm",
      cwd: "/tmp/evaluator"
    },
    {
      args: ["run", "lint"],
      commandLine: "npm",
      cwd: "/tmp/evaluator"
    },
    {
      args: ["run", "ruff", "format", "--check", "."],
      commandLine: "uv",
      cwd: "/tmp/api"
    },
    {
      args: ["run", "ruff", "check", "."],
      commandLine: "uv",
      cwd: "/tmp/api"
    }
  ]);
});

test("runProjects installs workspace dependencies once from the root", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-install-"));
  const calls = [];

  try {
    await fs.writeFile(
      path.join(tempDirectory, "package.json"),
      JSON.stringify({ workspaces: ["packages/*"] }, null, 2)
    );
    await fs.writeFile(path.join(tempDirectory, "package-lock.json"), "{}");
    await fs.mkdir(path.join(tempDirectory, "packages", "evaluator"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "packages", "evaluator", "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }, null, 2)
    );

    async function commandExecutor(commandLine, args, cwd) {
      calls.push({ args, commandLine, cwd });
    }

    const summary = await runProjects(
      [
        {
          rootPath: path.join(tempDirectory, "packages", "evaluator"),
          relativePath: "packages/evaluator",
          targets: [
            {
              ecosystem: "node",
              manifestPath: path.join(tempDirectory, "packages", "evaluator", "package.json"),
              metadata: {
                scripts: {
                  lint: "eslint ."
                }
              }
            }
          ]
        }
      ],
      {
        autoInstall: true,
        changedOnly: false,
        headRef: "HEAD",
        nodeInstallCommand: "npm ci",
        pythonFormatCommand: "uv run ruff format --check .",
        pythonLintCommand: "uv run ruff check .",
        workingDirectory: tempDirectory
      },
      commandExecutor
    );

    assert.deepEqual(summary.passedProjectPaths, ["packages/evaluator"]);
    assert.deepEqual(summary.failedProjectPaths, []);
    assert.deepEqual(calls, [
      {
        args: ["ci"],
        commandLine: "npm",
        cwd: tempDirectory
      },
      {
        args: ["run", "lint"],
        commandLine: "npm",
        cwd: path.join(tempDirectory, "packages", "evaluator")
      }
    ]);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("runProjects skips auto-install for node projects with no runnable scripts", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-no-install-"));
  const calls = [];

  try {
    await fs.writeFile(path.join(tempDirectory, "package-lock.json"), "{}");

    async function commandExecutor(commandLine, args, cwd) {
      calls.push({ args, commandLine, cwd });
    }

    const summary = await runProjects(
      [
        {
          rootPath: tempDirectory,
          relativePath: ".",
          targets: [
            {
              ecosystem: "node",
              manifestPath: path.join(tempDirectory, "package.json"),
              metadata: {
                scripts: {}
              }
            }
          ]
        }
      ],
      {
        autoInstall: true,
        changedOnly: false,
        headRef: "HEAD",
        nodeInstallCommand: "npm ci",
        pythonFormatCommand: "uv run ruff format --check .",
        pythonLintCommand: "uv run ruff check .",
        workingDirectory: tempDirectory
      },
      commandExecutor
    );

    assert.deepEqual(summary.passedProjectPaths, ["."]);
    assert.deepEqual(summary.failedProjectPaths, []);
    assert.deepEqual(calls, []);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("selectProjectsForExecution uses merge-base for pull requests", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-pr-diff-"));
  const previousEventName = process.env.GITHUB_EVENT_NAME;

  try {
    await fs.mkdir(path.join(tempDirectory, "evaluator"), { recursive: true });
    await fs.mkdir(path.join(tempDirectory, ".github", "workflows"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "evaluator", "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }, null, 2)
    );

    await runGit(tempDirectory, ["init", "-b", "main"]);
    await runGit(tempDirectory, ["config", "user.name", "Test User"]);
    await runGit(tempDirectory, ["config", "user.email", "test@example.com"]);
    await runGit(tempDirectory, ["config", "commit.gpgsign", "false"]);
    await runGit(tempDirectory, ["add", "."]);
    await runGit(tempDirectory, ["commit", "-m", "base"]);
    await runGit(tempDirectory, ["checkout", "-b", "feature/pr-only-workflow"]);

    await runGit(tempDirectory, ["checkout", "main"]);
    await fs.writeFile(path.join(tempDirectory, "evaluator", "index.ts"), "export const x = 1;\n");
    await runGit(tempDirectory, ["add", "."]);
    await runGit(tempDirectory, ["commit", "-m", "main changes evaluator"]);

    await runGit(tempDirectory, ["checkout", "feature/pr-only-workflow"]);
    await fs.writeFile(
      path.join(tempDirectory, ".github", "workflows", "ci.yml"),
      "name: ci\n"
    );
    await runGit(tempDirectory, ["add", "."]);
    await runGit(tempDirectory, ["commit", "-m", "workflow only"]);

    process.env.GITHUB_EVENT_NAME = "pull_request";

    const summary = await selectProjectsForExecution(
      [
        {
          rootPath: path.join(tempDirectory, "evaluator"),
          relativePath: "evaluator",
          targets: [
            {
              ecosystem: "node",
              manifestPath: path.join(tempDirectory, "evaluator", "package.json"),
              metadata: {
                scripts: {
                  lint: "eslint ."
                }
              }
            }
          ]
        }
      ],
      {
        autoInstall: false,
        baseRef: "main",
        changedOnly: true,
        headRef: "HEAD",
        nodeInstallCommand: "npm ci",
        pythonFormatCommand: "uv run ruff format --check .",
        pythonLintCommand: "uv run ruff check .",
        workingDirectory: tempDirectory
      }
    );

    assert.deepEqual(summary.changedFiles, [".github/workflows/ci.yml"]);
    assert.deepEqual(summary.selectedProjects, []);
  } finally {
    if (previousEventName === undefined) {
      delete process.env.GITHUB_EVENT_NAME;
    } else {
      process.env.GITHUB_EVENT_NAME = previousEventName;
    }

    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("selectProjectsForExecution surfaces actionable merge-base errors", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-pr-error-"));
  const previousEventName = process.env.GITHUB_EVENT_NAME;

  try {
    await runGit(tempDirectory, ["init", "-b", "main"]);
    process.env.GITHUB_EVENT_NAME = "pull_request";

    await assert.rejects(
      () =>
        selectProjectsForExecution([], {
          autoInstall: false,
          baseRef: "missing-base-ref",
          changedOnly: true,
          headRef: "HEAD",
          nodeInstallCommand: "npm ci",
          pythonFormatCommand: "uv run ruff format --check .",
          pythonLintCommand: "uv run ruff check .",
          workingDirectory: tempDirectory
        }),
      /Ensure both refs are present in the local checkout\. Use fetch-depth: 0/
    );
  } finally {
    if (previousEventName === undefined) {
      delete process.env.GITHUB_EVENT_NAME;
    } else {
      process.env.GITHUB_EVENT_NAME = previousEventName;
    }

    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

async function runGit(cwd, args) {
  const { execFile } = require("node:child_process");
  const { promisify } = require("node:util");
  const execFileAsync = promisify(execFile);

  await execFileAsync("git", args, { cwd });
}
