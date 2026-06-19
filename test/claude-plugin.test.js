import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { findClaudePluginViolations } from "../src/helpers/claude-plugin.js";

const withTempDir = async (run) => {
  const tempDirectory = await fs.mkdtemp(
    path.join(os.tmpdir(), "claude-plugin-"),
  );
  try {
    return await run(tempDirectory);
  } finally {
    await fs.rm(tempDirectory, { recursive: true, force: true });
  }
};

const writePluginManifest = async (dir, manifest, subdir = ".") => {
  const pluginDir = path.join(dir, subdir, ".claude-plugin");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "plugin.json"),
    JSON.stringify(manifest, null, 2),
  );
};

const writeMarketplaceManifest = async (dir, manifest) => {
  const pluginDir = path.join(dir, ".claude-plugin");
  await fs.mkdir(pluginDir, { recursive: true });
  await fs.writeFile(
    path.join(pluginDir, "marketplace.json"),
    JSON.stringify(manifest, null, 2),
  );
};

test("passes a plugin.json with a Title Case displayName", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "proposal-hub",
      displayName: "Proposal Hub",
    });

    const violations = await findClaudePluginViolations(dir);

    assert.deepEqual(violations, []);
  });
});

test("passes a displayName with capitalized acronyms and digits", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "api-gateway",
      displayName: "API Gateway 365",
    });

    const violations = await findClaudePluginViolations(dir);

    assert.deepEqual(violations, []);
  });
});

test("passes a run-together CamelCase displayName", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "agent-deploy",
      displayName: "AgentDeploy",
    });

    const violations = await findClaudePluginViolations(dir);

    assert.deepEqual(violations, []);
  });
});

test("passes a displayName with lowercase minor words after the first", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "proposals-of-the-year",
      displayName: "Proposals of the Year",
    });

    const violations = await findClaudePluginViolations(dir);

    assert.deepEqual(violations, []);
  });
});

test("flags a missing displayName", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, { name: "proposal-hub" });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("displayName")));
    assert.equal(violations[0].relativePath, ".claude-plugin/plugin.json");
  });
});

test("flags a kebab-case displayName", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "proposal-hub",
      displayName: "proposal-hub",
    });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("Title Case")));
  });
});

test("flags a lowercase displayName", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "proposal-hub",
      displayName: "proposal hub",
    });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("Title Case")));
  });
});

test("flags a displayName containing an underscore", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "proposal-hub",
      displayName: "Proposal_Hub",
    });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("underscore")));
  });
});

test("flags a non-kebab-case name", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "Proposal_Hub",
      displayName: "Proposal Hub",
    });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("kebab-case")));
  });
});

test("passes a plugin.json with kebab-case mcpServers keys", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "proposal-hub",
      displayName: "Proposal Hub",
      mcpServers: {
        "proposal-hub": { type: "http", url: "https://example.com/mcp" },
      },
    });

    const violations = await findClaudePluginViolations(dir);

    assert.deepEqual(violations, []);
  });
});

test("flags an mcpServers key containing an underscore", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "proposal-hub",
      displayName: "Proposal Hub",
      mcpServers: {
        Proposal_Hub: { type: "http", url: "https://example.com/mcp" },
      },
    });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("mcpServers")));
    assert.ok(violations[0].reasons.some((r) => r.includes("Proposal_Hub")));
  });
});

test("flags an mcpServers key with spaces", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(dir, {
      name: "proposal-hub",
      displayName: "Proposal Hub",
      mcpServers: {
        "Proposal Hub": { type: "http", url: "https://example.com/mcp" },
      },
    });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("kebab-case")));
  });
});

test("validates each entry in a marketplace.json", async () => {
  await withTempDir(async (dir) => {
    await writeMarketplaceManifest(dir, {
      name: "elementx",
      plugins: [
        { name: "proposal-hub", displayName: "Proposal Hub" },
        { name: "other-plugin", displayName: "other-plugin" },
      ],
    });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.equal(violations[0].relativePath, ".claude-plugin/marketplace.json");
    assert.ok(violations[0].reasons.some((r) => r.includes("other-plugin")));
    assert.ok(violations[0].reasons.some((r) => r.includes("Title Case")));
  });
});

test("flags a non-kebab-case marketplace top-level name", async () => {
  await withTempDir(async (dir) => {
    await writeMarketplaceManifest(dir, {
      name: "ElementX",
      plugins: [{ name: "proposal-hub", displayName: "Proposal Hub" }],
    });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some(
        (r) => r.includes("top-level") && r.includes("kebab-case"),
      ),
    );
  });
});

test("flags a top-level displayName in marketplace.json as ignored", async () => {
  await withTempDir(async (dir) => {
    await writeMarketplaceManifest(dir, {
      name: "agentdeploy",
      displayName: "AgentDeploy",
      plugins: [{ name: "agentdeploy", displayName: "AgentDeploy" }],
    });

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(
      violations[0].reasons.some(
        (r) => r.includes('top-level "displayName"') && r.includes("ignored"),
      ),
    );
  });
});

test("passes a marketplace.json with a kebab-case top-level name and no top-level displayName", async () => {
  await withTempDir(async (dir) => {
    await writeMarketplaceManifest(dir, {
      name: "elementx",
      plugins: [{ name: "proposal-hub", displayName: "Proposal Hub" }],
    });

    const violations = await findClaudePluginViolations(dir);

    assert.deepEqual(violations, []);
  });
});

test("discovers plugin manifests nested below the working directory", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(
      dir,
      { name: "nested", displayName: "nested" },
      "plugin",
    );

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.equal(
      violations[0].relativePath,
      path.join("plugin", ".claude-plugin", "plugin.json"),
    );
  });
});

test("ignores .claude-plugin directories inside node_modules", async () => {
  await withTempDir(async (dir) => {
    await writePluginManifest(
      dir,
      { name: "vendored", displayName: "vendored" },
      "node_modules/some-package",
    );

    const violations = await findClaudePluginViolations(dir);

    assert.deepEqual(violations, []);
  });
});

test("reports invalid JSON", async () => {
  await withTempDir(async (dir) => {
    const pluginDir = path.join(dir, ".claude-plugin");
    await fs.mkdir(pluginDir, { recursive: true });
    await fs.writeFile(path.join(pluginDir, "plugin.json"), "{ not json");

    const violations = await findClaudePluginViolations(dir);

    assert.equal(violations.length, 1);
    assert.ok(violations[0].reasons.some((r) => r.includes("not valid JSON")));
  });
});

test("returns nothing when there are no plugin manifests", async () => {
  await withTempDir(async (dir) => {
    await fs.writeFile(path.join(dir, "package.json"), "{}");

    const violations = await findClaudePluginViolations(dir);

    assert.deepEqual(violations, []);
  });
});
