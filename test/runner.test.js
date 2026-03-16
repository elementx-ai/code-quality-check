const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { runProjects } = require("../lib/runner.js");

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
