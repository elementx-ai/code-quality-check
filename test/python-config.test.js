import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MIN_DEPENDENCY_AGE_DAYS } from "../src/helpers/config-files.js";
import {
  findPythonConfigViolations,
  MIN_PYTHON_VERSION,
  MIN_UV_VERSION,
  RECOMMENDED_PYTHON_VERSION,
} from "../src/helpers/python-config.js";

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

const writeVersionPin = (dir) =>
  fs.writeFile(
    path.join(dir, ".python-version"),
    `${RECOMMENDED_PYTHON_VERSION}\n`,
  );

const pyprojectWith = (excludeNewer) =>
  `[project]\nname = "demo"\n\n[tool.uv]\nexclude-newer = "${excludeNewer}"\n`;

test("passes with a friendly-duration cooldown at the minimum", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith(`${MIN_DEPENDENCY_AGE_DAYS} days`),
    );

    const { violations, warnings } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
    assert.deepEqual(warnings, []);
  });
});

test("passes with an ISO 8601 duration above the minimum", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(path.join(dir, "pyproject.toml"), pyprojectWith("P1W"));

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("passes when the cooldown is set in uv.toml", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\n',
    );
    await fs.writeFile(
      path.join(dir, "uv.toml"),
      'exclude-newer = "72 hours"\n',
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("flags a missing cooldown", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\n',
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("exclude-newer")));
    assert.ok(
      violations[0].reasons.some((r) => r.includes(`uv ${MIN_UV_VERSION}`)),
    );
  });
});

test("flags a cooldown below the minimum", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("2 days"),
    );

    const { violations } = await findPythonConfigViolations(
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
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("2024-01-01"),
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("fixed date")));
  });
});

test("flags an unparseable duration", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("soon-ish"),
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("unparseable")));
  });
});

test("ignores exclude-newer outside the [tool.uv] table", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\n\n[tool.other]\nexclude-newer = "1 week"\n',
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("missing")));
  });
});

test("resolves the cooldown from an ancestor uv.toml in a workspace", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(path.join(dir, "uv.toml"), 'exclude-newer = "1 week"\n');
    const packageDir = path.join(dir, "packages", "api");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "pyproject.toml"),
      '[project]\nname = "api"\n',
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(packageDir, "packages/api")],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

const poetryPyproject = (extra = "") =>
  `[tool.poetry]\nname = "demo"\nversion = "0.1.0"\n${extra}`;

test("passes when a poetry project sets min-release-age at the minimum", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(path.join(dir, "pyproject.toml"), poetryPyproject());
    await fs.writeFile(
      path.join(dir, "poetry.toml"),
      `[solver]\nmin-release-age = ${MIN_DEPENDENCY_AGE_DAYS}\n`,
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("flags a poetry project missing min-release-age", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(path.join(dir, "pyproject.toml"), poetryPyproject());
    await fs.writeFile(path.join(dir, "poetry.lock"), "");

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("min-release-age")));
    assert.ok(violations[0].reasons.some((r) => r.includes("poetry.toml")));
  });
});

test("flags a poetry min-release-age below the minimum", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(path.join(dir, "pyproject.toml"), poetryPyproject());
    await fs.writeFile(
      path.join(dir, "poetry.toml"),
      "[solver]\nmin-release-age = 1\n",
    );

    const { violations } = await findPythonConfigViolations(
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

test("flags a non-integer poetry min-release-age", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(path.join(dir, "pyproject.toml"), poetryPyproject());
    await fs.writeFile(
      path.join(dir, "poetry.toml"),
      '[solver]\nmin-release-age = "3 days"\n',
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("invalid")));
  });
});

test("detects poetry via poetry-core build backend", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[build-system]\nrequires = ["poetry-core>=2.0.0"]\nbuild-backend = "poetry.core.masonry.api"\n',
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("min-release-age")));
  });
});

test("resolves poetry min-release-age from an ancestor poetry.toml", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "poetry.toml"),
      "[solver]\nmin-release-age = 7\n",
    );
    const packageDir = path.join(dir, "packages", "api");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "pyproject.toml"),
      poetryPyproject(),
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(packageDir, "packages/api")],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("accepts a uv cooldown when both managers are configured", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      poetryPyproject(`\n[tool.uv]\nexclude-newer = "1 week"\n`),
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("treats a [tool.poetry] pyproject without poetry.toml as poetry", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[tool.poetry]\nname = "demo"\nversion = "1.0.0"\n\n[build-system]\nrequires = ["poetry-core"]\nbuild-backend = "poetry.core.masonry.api"\n',
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("min-release-age")));
    assert.ok(violations[0].reasons.every((r) => !r.includes("exclude-newer")));
  });
});

test("flags a missing .python-version", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("1 week"),
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes(".python-version")));
  });
});

test("flags a .python-version below the minimum", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, ".python-version"), "3.12\n");
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("1 week"),
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some((r) =>
        r.includes(`minimum is ${MIN_PYTHON_VERSION}`),
      ),
    );
  });
});

test("rejects a non-numeric .python-version", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, ".python-version"), "pypy3.10\n");
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("1 week"),
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some((r) => r.includes("numeric Python version")),
    );
  });
});

test("warns when .python-version is at the minimum but below the recommended", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".python-version"),
      `${MIN_PYTHON_VERSION}\n`,
    );
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("1 week"),
    );

    const { violations, warnings } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
    assert.equal(warnings.length, 1);
    assert.ok(
      warnings[0].reasons.some((r) =>
        r.includes(`recommended minimum is ${RECOMMENDED_PYTHON_VERSION}`),
      ),
    );
  });
});

test("accepts a patch-level .python-version above the recommended", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, ".python-version"), "3.14.1\n");
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      pyprojectWith("1 week"),
    );

    const { violations, warnings } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
    assert.deepEqual(warnings, []);
  });
});

test("resolves .python-version from an ancestor directory in a monorepo", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    const packageDir = path.join(dir, "packages", "api");
    await fs.mkdir(packageDir, { recursive: true });
    await fs.writeFile(
      path.join(packageDir, "pyproject.toml"),
      pyprojectWith("1 week"),
    );

    const { violations, warnings } = await findPythonConfigViolations(
      [pythonProject(packageDir, "packages/api")],
      dir,
    );

    assert.deepEqual(violations, []);
    assert.deepEqual(warnings, []);
  });
});

test("flags requires-python below the minimum", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      '[project]\nname = "demo"\nrequires-python = ">=3.11"\n\n[tool.uv]\nexclude-newer = "1 week"\n',
    );

    const { violations } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some(
        (r) =>
          r.includes("requires-python") &&
          r.includes(`minimum is ${MIN_PYTHON_VERSION}`),
      ),
    );
  });
});

test("warns when requires-python floor is at the minimum but below the recommended", async () => {
  await withTempDir(async (dir) => {
    await writeVersionPin(dir);
    await fs.writeFile(
      path.join(dir, "pyproject.toml"),
      `[project]\nname = "demo"\nrequires-python = ">=${MIN_PYTHON_VERSION}"\n\n[tool.uv]\nexclude-newer = "1 week"\n`,
    );

    const { violations, warnings } = await findPythonConfigViolations(
      [pythonProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
    assert.equal(warnings.length, 1);
    assert.ok(warnings[0].reasons.some((r) => r.includes("requires-python")));
  });
});

test("ignores non-Python projects", async () => {
  await withTempDir(async (dir) => {
    const { violations } = await findPythonConfigViolations(
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
