const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const { detectPythonRuff, detectRepoMode, discoverProjects } = require("../lib/discovery.js");

test("discoverProjects finds Node and Python project roots", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-"));

  try {
    await fs.writeFile(
      path.join(tempDirectory, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }, null, 2)
    );
    await fs.mkdir(path.join(tempDirectory, "packages", "web"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "packages", "web", "package.json"),
      JSON.stringify({ scripts: { build: "vite build" } }, null, 2)
    );
    await fs.mkdir(path.join(tempDirectory, "services", "api"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "services", "api", "pyproject.toml"),
      [
        "[project]",
        'name = "api"',
        'dependencies = ["ruff>=0.11.0"]',
        "",
        "[tool.ruff]",
        'line-length = 100',
        ""
      ].join("\n")
    );

    const projects = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(
      projects.map((project) => project.relativePath),
      [".", "packages/web", "services/api"]
    );
    assert.equal(detectRepoMode(projects), "monorepo");
    assert.equal(
      projects.find((project) => project.relativePath === "services/api").targets[0].metadata.hasRuff,
      true
    );
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("detectPythonRuff returns false when Ruff is not referenced", () => {
  assert.equal(
    detectPythonRuff(
      [
        "[project]",
        'name = "api"',
        'dependencies = ["fastapi>=0.100.0"]',
        ""
      ].join("\n")
    ),
    false
  );
});
