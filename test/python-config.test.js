import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MIN_DEPENDENCY_AGE_DAYS } from "../src/helpers/config-files.js";
import { findPythonConfigViolations } from "../src/helpers/python-config.js";

const withTempDir = async (run) => {
  const tempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "python-config-"),
  );
  try {
    return await run(tempDirectory);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
};

const pythonProject = (rootPath, relativePath = ".") => ({
  rootPath,
  relativePath,
  targets: [
    {
      ecosystem: "python",
      manifestPath: path.join(rootPath, "pyproject.toml"),
      metadata: { hasRuff: true },
    },
  ],
});

const pyprojectWith = (excludeNewer) =>
  `[project]\nname = "demo"\n\n[tool.uv]\nexclude-newer = "${excludeNewer}"\n`;

test("passes with a friendly-duration cooldown at the minimum", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith(`${MIN_DEPENDENCY_AGE_DAYS} days`),
    );

    const violations = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("passes with an ISO 8601 duration above the minimum", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "pyproject.toml"), pyprojectWith("P1W"));

    const violations = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("passes when the cooldown is set in uv.toml", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\n',
    );
    await fs.writeFile(
      path.join(dir, "uv.toml"),
      'exclude-newer = "72 hours"\n',
    );

    const violations = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("flags a missing cooldown", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\n',
    );

    const violations = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("exclude-newer")));
  });
});

test("flags a cooldown below the minimum", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("2 days"),
    );

    const violations = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some((r) =>
        r.includes(`minimum cooldown is ${MIN_DEPENDENCY_AGE_DAYS}`),
      ),
    );
  });
});

test("flags an absolute exclude-newer date as not a rolling cooldown", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("2024-01-01"),
    );

    const violations = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("fixed date")));
  });
});

test("flags an unparseable duration", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("soon-ish"),
    );

    const violations = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("unparseable")));
  });
});

test("ignores exclude-newer outside the [tool.uv] table", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\n\n[tool.other]\nexclude-newer = "1 week"\n',
    );

    const violations = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("missing")));
  });
});

test("resolves the cooldown from an ancestor uv.toml in a workspace", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "uv.toml"), 'exclude-newer = "1 week"\n');
    const packageDir = path.join(dir, "packages", "api");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "pyproject.toml"),
      '[project]\nname = "api"\n',
    );

    const violations = await findPythonConfigViolations(
      [pythonProject(packageDir, "packages/api")],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("ignores non-Python projects", async () => {
  await withTempDir(async (dir) => {
    const violations = await findPythonConfigViolations(
      [
        {
          rootPath: dir,
          relativePath: ".",
          targets: [
            {
              ecosystem: "node",
              manifestPath: path.join(dir, "package.json"),
              metadata: { scripts: {} },
            },
          ],
        },
      ],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});
