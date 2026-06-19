import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { MIN_DEPENDENCY_AGE_DAYS } from "../src/helpers/config-files.js";
import {
  findNodeConfigViolations,
  MIN_NODE_MAJOR_VERSION,
  MIN_NPM_VERSION,
  RECOMMENDED_NODE_MAJOR_VERSION,
} from "../src/helpers/node-config.js";

const withTempDir = async (run) => {
  const tempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "node-config-"),
  );
  try {
    return await run(tempDirectory);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
};

const nodeProject = (rootPath, relativePath = ".") => ({
  rootPath,
  relativePath,
  targets: [
    {
      ecosystem: "node",
      manifestPath: path.join(rootPath, "package.json"),
      metadata: { scripts: { format: "prettier .", lint: "eslint ." } },
    },
  ],
});

const validNpmrc = `min-release-age=${MIN_DEPENDENCY_AGE_DAYS}\n`;

test("passes when .nvmrc and .npmrc satisfy the policy", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".nvmrc"),
      `${RECOMMENDED_NODE_MAJOR_VERSION}\n`,
    );
    await fs.writeFile(path.join(dir, ".npmrc"), validNpmrc);

    const { violations, warnings } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
    assert.deepEqual(warnings, []);
  });
});

test("rejects nvm aliases in .nvmrc", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, ".nvmrc"), "lts/iron\n");
    await fs.writeFile(path.join(dir, ".npmrc"), "min-release-age=7\n");

    const { violations } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some((r) => r.includes("numeric Node version")),
    );
  });
});

test("accepts v-prefixed versions in .nvmrc", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".nvmrc"),
      `v${RECOMMENDED_NODE_MAJOR_VERSION}\n`,
    );
    await fs.writeFile(path.join(dir, ".npmrc"), "min-release-age=7\n");

    const { violations, warnings } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
    assert.deepEqual(warnings, []);
  });
});

test("flags a Node version below the minimum", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".nvmrc"),
      `${MIN_NODE_MAJOR_VERSION - 1}\n`,
    );
    await fs.writeFile(path.join(dir, ".npmrc"), validNpmrc);

    const { violations } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some((r) =>
        r.includes(`minimum is ${MIN_NODE_MAJOR_VERSION}`),
      ),
    );
  });
});

test("warns when the Node version is at the minimum but below the recommended", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, ".nvmrc"), `${MIN_NODE_MAJOR_VERSION}\n`);
    await fs.writeFile(path.join(dir, ".npmrc"), validNpmrc);

    const { violations, warnings } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.deepEqual(violations, []);
    assert.equal(warnings.length, 1);
    assert.ok(
      warnings[0].reasons.some((r) =>
        r.includes(`recommended minimum is ${RECOMMENDED_NODE_MAJOR_VERSION}`),
      ),
    );
  });
});

test("flags a missing .nvmrc", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, ".npmrc"), validNpmrc);

    const { violations } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes(".nvmrc")));
  });
});

test("flags an empty or invalid .nvmrc version", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, ".nvmrc"), "not-a-version\n");
    await fs.writeFile(path.join(dir, ".npmrc"), validNpmrc);

    const { violations } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some((r) => r.includes("numeric Node version")),
    );
  });
});

test("flags a missing .npmrc", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".nvmrc"),
      `${RECOMMENDED_NODE_MAJOR_VERSION}\n`,
    );

    const { violations } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("min-release-age")));
    assert.ok(
      violations[0].reasons.some((r) => r.includes(`npm v${MIN_NPM_VERSION}`)),
    );
  });
});

test("flags a missing min-release-age setting", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".nvmrc"),
      `${RECOMMENDED_NODE_MAJOR_VERSION}\n`,
    );
    await fs.writeFile(path.join(dir, ".npmrc"), "save-exact=true\n");

    const { violations } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("not present")));
  });
});

test("flags a min-release-age below the minimum", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".nvmrc"),
      `${RECOMMENDED_NODE_MAJOR_VERSION}\n`,
    );
    await fs.writeFile(path.join(dir, ".npmrc"), "min-release-age=2\n");

    const { violations } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some((r) =>
        r.includes(`minimum is ${MIN_DEPENDENCY_AGE_DAYS}`),
      ),
    );
  });
});

test("flags a non-integer min-release-age value", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".nvmrc"),
      `${RECOMMENDED_NODE_MAJOR_VERSION}\n`,
    );
    await fs.writeFile(path.join(dir, ".npmrc"), "min-release-age=3days\n");

    const { violations } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("invalid")));
  });
});

test("resolves config files from an ancestor directory in a monorepo", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(
      path.join(dir, ".nvmrc"),
      `${RECOMMENDED_NODE_MAJOR_VERSION}\n`,
    );
    await fs.writeFile(path.join(dir, ".npmrc"), validNpmrc);
    const packageDir = path.join(dir, "packages", "app");
    await fs.mkdir(packageDir, { recursive: true });

    const { violations } = await findNodeConfigViolations(
      [nodeProject(packageDir, "packages/app")],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("ignores non-Node projects", async () => {
  await withTempDir(async (dir) => {
    const { violations } = await findNodeConfigViolations(
      [
        {
          rootPath: dir,
          relativePath: ".",
          targets: [
            {
              ecosystem: "python",
              manifestPath: path.join(dir, "pyproject.toml"),
              metadata: { hasRuff: true },
            },
          ],
        },
      ],
      dir,
    );

    assert.deepEqual(violations, []);
  });
});

test("reports both missing files in a single violation entry", async () => {
  await withTempDir(async (dir) => {
    const { violations } = await findNodeConfigViolations(
      [nodeProject(dir)],
      dir,
    );

    assert.equal(violations.length, 1);
    assert.equal(violations[0].reasons.length, 2);
  });
});
