const assert = require("node:assert/strict");
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
      changedOnly: false,
      headRef: "HEAD",
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
