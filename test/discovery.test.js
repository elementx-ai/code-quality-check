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

    const { projects } = await discoverProjects(tempDirectory, { includeRoot: true });

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

test("discoverProjects respects projectDepth", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-depth-"));

  try {
    await fs.writeFile(
      path.join(tempDirectory, "package.json"),
      JSON.stringify({ scripts: { lint: "eslint ." } }, null, 2)
    );
    await fs.mkdir(path.join(tempDirectory, "evaluator"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "evaluator", "package.json"),
      JSON.stringify({ scripts: { test: "vitest" } }, null, 2)
    );
    await fs.mkdir(path.join(tempDirectory, "services", "api"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "services", "api", "package.json"),
      JSON.stringify({ scripts: { build: "tsc" } }, null, 2)
    );

    const { projects: rootOnlyProjects } = await discoverProjects(tempDirectory, {
      includeRoot: true,
      projectDepth: 0
    });
    const { projects: oneLevelProjects } = await discoverProjects(tempDirectory, {
      includeRoot: true,
      projectDepth: 1
    });
    const { projects: unlimitedProjects } = await discoverProjects(tempDirectory, {
      includeRoot: true,
      projectDepth: -1
    });

    assert.deepEqual(
      rootOnlyProjects.map((project) => project.relativePath),
      ["."]
    );
    assert.deepEqual(
      oneLevelProjects.map((project) => project.relativePath),
      [".", "evaluator"]
    );
    assert.deepEqual(
      unlimitedProjects.map((project) => project.relativePath),
      [".", "evaluator", "services/api"]
    );
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects finds Terraform projects in tf directories", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-tf-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "tf"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "tf", "main.tf"),
      'resource "aws_s3_bucket" "example" {}\n'
    );

    const { projects } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(
      projects.map((project) => project.relativePath),
      ["tf"]
    );
    assert.equal(projects[0].targets[0].ecosystem, "terraform");
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects finds Terraform projects in monorepo tf directories", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-tf-mono-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "services", "api"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "services", "api", "package.json"),
      JSON.stringify({ scripts: { format: "prettier .", lint: "eslint ." } }, null, 2)
    );
    await fs.mkdir(path.join(tempDirectory, "services", "api", "tf"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "services", "api", "tf", "main.tf"),
      'resource "aws_s3_bucket" "example" {}\n'
    );

    const { projects } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(
      projects.map((project) => project.relativePath),
      ["services/api", "services/api/tf"]
    );
    assert.equal(projects[0].targets[0].ecosystem, "node");
    assert.equal(projects[1].targets[0].ecosystem, "terraform");
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects ignores tf directories without .tf files", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-tf-empty-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "tf"), { recursive: true });
    await fs.writeFile(path.join(tempDirectory, "tf", "readme.md"), "# Not terraform\n");

    const { projects } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(projects, []);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects finds Terraform projects in module directories", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-tf-module-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "module"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "module", "vpc.tf"),
      'resource "aws_vpc" "main" {}\n'
    );

    const { projects } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(
      projects.map((project) => project.relativePath),
      ["module"]
    );
    assert.equal(projects[0].targets[0].ecosystem, "terraform");
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects does not flag .tf files inside module directories as misplaced", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-module-ok-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "module"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "module", "vpc.tf"),
      'resource "aws_vpc" "main" {}\n'
    );

    const { misplacedTerraformFiles } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(misplacedTerraformFiles, []);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects discovers root-level .tf files as a Terraform project", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-root-tf-"));

  try {
    await fs.writeFile(
      path.join(tempDirectory, "main.tf"),
      'resource "aws_s3_bucket" "example" {}\n'
    );

    const { projects, misplacedTerraformFiles } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(misplacedTerraformFiles, []);
    assert.equal(projects.length, 1);
    assert.equal(projects[0].relativePath, ".");
    assert.equal(projects[0].targets[0].ecosystem, "terraform");
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects detects .tf files in non-tf subdirectories", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-misplaced-sub-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "infra"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "infra", "main.tf"),
      'resource "aws_s3_bucket" "example" {}\n'
    );
    await fs.mkdir(path.join(tempDirectory, "services", "api", "deploy"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "services", "api", "deploy", "rds.tf"),
      'resource "aws_db_instance" "example" {}\n'
    );

    const { misplacedTerraformFiles } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(misplacedTerraformFiles, ["infra/main.tf", "services/api/deploy/rds.tf"]);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects reports no misplaced files when .tf files are in tf directories", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-tf-ok-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "tf"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "tf", "main.tf"),
      'resource "aws_s3_bucket" "example" {}\n'
    );
    await fs.mkdir(path.join(tempDirectory, "services", "api", "tf"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "services", "api", "tf", "rds.tf"),
      'resource "aws_db_instance" "example" {}\n'
    );

    const { misplacedTerraformFiles } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(misplacedTerraformFiles, []);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects reports no misplaced files when no .tf files exist", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-no-tf-"));

  try {
    await fs.writeFile(path.join(tempDirectory, "index.ts"), "export const x = 1;\n");

    const { misplacedTerraformFiles } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(misplacedTerraformFiles, []);
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

test("discoverProjects finds Terraform projects with .tf files in nested subdirectories of module", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-tf-nested-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "module", "vpc"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "module", "vpc", "main.tf"),
      'resource "aws_vpc" "main" {}\n'
    );

    const { projects, misplacedTerraformFiles } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(misplacedTerraformFiles, []);
    assert.deepEqual(
      projects.map((project) => project.relativePath),
      ["module"]
    );
    assert.equal(projects[0].targets[0].ecosystem, "terraform");
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects finds Terraform projects with .tf files in nested subdirectories of tf", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-tf-nested2-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "tf", "modules", "s3"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "tf", "modules", "s3", "main.tf"),
      'resource "aws_s3_bucket" "example" {}\n'
    );

    const { projects, misplacedTerraformFiles } = await discoverProjects(tempDirectory, { includeRoot: true });

    assert.deepEqual(misplacedTerraformFiles, []);
    assert.deepEqual(
      projects.map((project) => project.relativePath),
      ["tf"]
    );
    assert.equal(projects[0].targets[0].ecosystem, "terraform");
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});

test("discoverProjects finds Terraform projects in root-level tf directories when includeRoot is false", async () => {
  const tempDirectory = await fs.mkdtemp(path.join(os.tmpdir(), "project-checks-tf-root-"));

  try {
    await fs.mkdir(path.join(tempDirectory, "tf"), { recursive: true });
    await fs.writeFile(
      path.join(tempDirectory, "tf", "main.tf"),
      'resource "aws_s3_bucket" "example" {}\n'
    );

    const { projects } = await discoverProjects(tempDirectory, { includeRoot: false });

    assert.equal(projects.length, 1);
    assert.equal(projects[0].relativePath, "tf");
    assert.equal(projects[0].targets[0].ecosystem, "terraform");
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
});
