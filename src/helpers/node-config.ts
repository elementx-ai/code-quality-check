import {
  ConfigViolation,
  MIN_DEPENDENCY_AGE_DAYS,
  readFileUpwards,
} from "./config-files.js";

import { Project } from "../types.js";

export const MIN_NODE_MAJOR_VERSION = 24;

const nodeVersionPattern = /^v?(\d+)(?:\.\d+){0,2}$/;

const parseNodeMajorVersion = (value: string): number | undefined => {
  const match = nodeVersionPattern.exec(value);
  return match ? Number.parseInt(match[1], 10) : undefined;
};

const firstNonEmptyLine = (content: string): string =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

const parseMinReleaseAge = (content: string): string | undefined =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith(";") && !line.startsWith("#"))
    .map((line) => /^min-release-age\s*=\s*(.+)$/i.exec(line))
    .filter((match): match is RegExpExecArray => match !== null)
    .map((match) => match[1].trim().replace(/^["']|["']$/g, ""))
    .at(-1);

const validateNvmrc = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<string | undefined> => {
  const resolved = await readFileUpwards(rootPath, boundaryDirectory, ".nvmrc");
  if (!resolved) {
    return `missing a .nvmrc file pinning the Node version to at least ${MIN_NODE_MAJOR_VERSION} (for example "${MIN_NODE_MAJOR_VERSION}")`;
  }

  const version = firstNonEmptyLine(resolved.content);
  const major = parseNodeMajorVersion(version);
  if (major === undefined) {
    return `${resolved.relativePath} must pin a numeric Node version of at least ${MIN_NODE_MAJOR_VERSION} (nvm aliases such as "lts/*" or "node" are not allowed), found: "${version || "<empty>"}"`;
  }

  if (major < MIN_NODE_MAJOR_VERSION) {
    return `${resolved.relativePath} pins Node ${version} but the minimum is ${MIN_NODE_MAJOR_VERSION}`;
  }

  return undefined;
};

const validateNpmrc = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<string | undefined> => {
  const resolved = await readFileUpwards(rootPath, boundaryDirectory, ".npmrc");
  if (!resolved) {
    return `missing a .npmrc file with "min-release-age=${MIN_DEPENDENCY_AGE_DAYS}" (requires npm v11.10+)`;
  }

  const rawValue = parseMinReleaseAge(resolved.content);
  if (rawValue === undefined) {
    return `${resolved.relativePath} must set "min-release-age" to at least ${MIN_DEPENDENCY_AGE_DAYS}, but the setting is not present`;
  }

  const days = Number.parseInt(rawValue, 10);
  if (Number.isNaN(days) || String(days) !== rawValue) {
    return `${resolved.relativePath} has an invalid "min-release-age" value: "${rawValue}" (expected an integer number of days)`;
  }

  if (days < MIN_DEPENDENCY_AGE_DAYS) {
    return `${resolved.relativePath} sets "min-release-age=${days}" but the minimum is ${MIN_DEPENDENCY_AGE_DAYS} days`;
  }

  return undefined;
};

const projectHasNodeTarget = (project: Project): boolean =>
  project.targets.some((target) => target.ecosystem === "node");

export const findNodeConfigViolations = async (
  projects: Project[],
  boundaryDirectory: string,
): Promise<ConfigViolation[]> => {
  const nodeProjects = projects.filter(projectHasNodeTarget);

  const violations = await Promise.all(
    nodeProjects.map(async (project) => {
      const reasons = (
        await Promise.all([
          validateNvmrc(project.rootPath, boundaryDirectory),
          validateNpmrc(project.rootPath, boundaryDirectory),
        ])
      ).filter((reason): reason is string => reason !== undefined);

      return reasons.length > 0
        ? { reasons, relativePath: project.relativePath }
        : undefined;
    }),
  );

  return violations.filter(
    (violation): violation is ConfigViolation => violation !== undefined,
  );
};
