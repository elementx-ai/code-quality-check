import { promises as fs } from "node:fs";
import path from "node:path";

import { ConfigViolation, readFileIfExists } from "./config-files.js";

const ignoredDirectories = new Set([
  ".git",
  ".hg",
  ".pnpm-store",
  ".venv",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv",
]);

const kebabNamePattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

// Lowercase connector words that conventional title case leaves uncapitalized
// when they are not the first word (e.g. "Proposals of the Year").
const minorWords = new Set([
  "a",
  "an",
  "and",
  "as",
  "at",
  "but",
  "by",
  "for",
  "if",
  "in",
  "nor",
  "of",
  "on",
  "or",
  "per",
  "the",
  "to",
  "via",
  "vs",
  "with",
]);

interface PluginEntry {
  displayName?: unknown;
  label: string;
  name?: unknown;
}

const validateMcpServerNames = (mcpServers: unknown): string[] => {
  if (
    typeof mcpServers !== "object" ||
    mcpServers === null ||
    Array.isArray(mcpServers)
  ) {
    return [];
  }

  return Object.keys(mcpServers)
    .filter((serverName) => !kebabNamePattern.test(serverName))
    .map(
      (serverName) =>
        `plugin.json "mcpServers" key must be a kebab-case identifier (lowercase letters, digits, and hyphens), ` +
        `since it is shown verbatim as the connector name and prefixes the MCP tool namespace, ` +
        `found: ${JSON.stringify(serverName)}`,
    );
};

const isTitleCase = (value: string): boolean => {
  const words = value.trim().split(/\s+/);
  if (words.length === 0 || words[0] === "") {
    return false;
  }
  return words.every((word, index) => {
    if (index > 0 && minorWords.has(word.toLowerCase())) {
      return true;
    }
    return /^[A-Z0-9]/.test(word);
  });
};

const validateEntry = (entry: PluginEntry): string[] => {
  const reasons: string[] = [];

  if (typeof entry.name !== "string" || !kebabNamePattern.test(entry.name)) {
    reasons.push(
      `${entry.label} "name" must be a kebab-case identifier (lowercase letters, digits, and hyphens), ` +
        `found: ${JSON.stringify(entry.name)}`,
    );
  }

  if (
    typeof entry.displayName !== "string" ||
    entry.displayName.trim() === ""
  ) {
    reasons.push(
      `${entry.label} must set a human-readable "displayName" (Title Case, e.g. "Proposal Hub"); ` +
        `without it the marketplace and connector UI fall back to the kebab-case "name". ` +
        `Requires Claude Code v2.1.143+`,
    );
  } else if (entry.displayName.includes("_")) {
    reasons.push(
      `${entry.label} "displayName" must not contain underscores: ${JSON.stringify(entry.displayName)}`,
    );
  } else if (!isTitleCase(entry.displayName)) {
    reasons.push(
      `${entry.label} "displayName" must be Title Case (each word capitalized, e.g. "Proposal Hub"), ` +
        `found: ${JSON.stringify(entry.displayName)}`,
    );
  }

  return reasons;
};

const parseJson = (content: string): unknown | undefined => {
  try {
    return JSON.parse(content);
  } catch {
    return undefined;
  }
};

const validatePluginManifest = async (
  manifestPath: string,
  relativePath: string,
): Promise<ConfigViolation | undefined> => {
  const content = await readFileIfExists(manifestPath);
  if (content === undefined) {
    return undefined;
  }

  const parsed = parseJson(content);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return { reasons: ["is not valid JSON"], relativePath };
  }

  const manifest = parsed as {
    displayName?: unknown;
    mcpServers?: unknown;
    name?: unknown;
  };
  const reasons = [
    ...validateEntry({
      displayName: manifest.displayName,
      label: "plugin.json",
      name: manifest.name,
    }),
    ...validateMcpServerNames(manifest.mcpServers),
  ];

  return reasons.length > 0 ? { reasons, relativePath } : undefined;
};

const validateMarketplaceTopLevel = (marketplace: {
  displayName?: unknown;
  name?: unknown;
}): string[] => {
  const reasons: string[] = [];

  if (
    typeof marketplace.name !== "string" ||
    !kebabNamePattern.test(marketplace.name)
  ) {
    reasons.push(
      `marketplace.json top-level "name" must be a kebab-case identifier (lowercase letters, digits, and hyphens); ` +
        `it is the public marketplace id users type in "/plugin install <plugin>@<marketplace>", ` +
        `found: ${JSON.stringify(marketplace.name)}`,
    );
  }

  if (marketplace.displayName !== undefined) {
    reasons.push(
      `marketplace.json has no top-level "displayName" field, so this one is silently ignored; ` +
        `set a human-readable "displayName" on each entry of the "plugins" array instead, ` +
        `found: ${JSON.stringify(marketplace.displayName)}`,
    );
  }

  return reasons;
};

const validateMarketplaceManifest = async (
  manifestPath: string,
  relativePath: string,
): Promise<ConfigViolation | undefined> => {
  const content = await readFileIfExists(manifestPath);
  if (content === undefined) {
    return undefined;
  }

  const parsed = parseJson(content);
  if (parsed === undefined || typeof parsed !== "object" || parsed === null) {
    return { reasons: ["is not valid JSON"], relativePath };
  }

  const marketplace = parsed as {
    displayName?: unknown;
    name?: unknown;
    plugins?: unknown;
  };

  const topLevelReasons = validateMarketplaceTopLevel(marketplace);

  const plugins = marketplace.plugins;
  if (!Array.isArray(plugins)) {
    return topLevelReasons.length > 0
      ? { reasons: topLevelReasons, relativePath }
      : undefined;
  }

  const reasons = [
    ...topLevelReasons,
    ...plugins.flatMap((plugin, index) => {
      const entry = (plugin ?? {}) as { displayName?: unknown; name?: unknown };
      const identifier =
        typeof entry.name === "string" ? entry.name : `#${index}`;
      return validateEntry({
        displayName: entry.displayName,
        label: `plugins[${identifier}]`,
        name: entry.name,
      });
    }),
  ];

  return reasons.length > 0 ? { reasons, relativePath } : undefined;
};

const findClaudePluginDirectories = async (
  workingDirectory: string,
): Promise<string[]> => {
  const walk = async (currentDirectory: string): Promise<string[]> => {
    const entries = await fs
      .readdir(currentDirectory, { withFileTypes: true })
      .catch(() => []);

    const directories = entries.filter(
      (entry) => entry.isDirectory() && !ignoredDirectories.has(entry.name),
    );

    const nested = await Promise.all(
      directories.map(async (entry) => {
        const childPath = path.join(currentDirectory, entry.name);
        if (entry.name === ".claude-plugin") {
          return [childPath];
        }
        return walk(childPath);
      }),
    );

    return nested.flat();
  };

  return walk(workingDirectory);
};

export const findClaudePluginViolations = async (
  workingDirectory: string,
): Promise<ConfigViolation[]> => {
  const pluginDirectories = await findClaudePluginDirectories(workingDirectory);

  const violations = await Promise.all(
    pluginDirectories.flatMap((directory) => [
      validatePluginManifest(
        path.join(directory, "plugin.json"),
        path.relative(workingDirectory, path.join(directory, "plugin.json")),
      ),
      validateMarketplaceManifest(
        path.join(directory, "marketplace.json"),
        path.relative(
          workingDirectory,
          path.join(directory, "marketplace.json"),
        ),
      ),
    ]),
  );

  return violations.filter(
    (violation): violation is ConfigViolation => violation !== undefined,
  );
};
