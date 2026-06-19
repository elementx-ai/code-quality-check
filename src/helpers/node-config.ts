import {
  CheckFinding,
  ConfigCheckResult,
  MIN_DEPENDENCY_AGE_DAYS,
  collectFindings,
  firstNonEmptyLine,
  readFileUpwards,
} from "./config-files.js";

import { Project } from "../types.js";

export const MIN_NODE_MAJOR_VERSION = 22;
export const RECOMMENDED_NODE_MAJOR_VERSION = 24;

const nodeVersionPattern = /^v?(\d+)(?:\.\d+){0,2}$/;

const parseNodeMajorVersion = (value: string): number | undefined => {
  const match = nodeVersionPattern.exec(value);
  return match ? Number.parseInt(match[1], 10) : undefined;
};

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
): Promise<CheckFinding | undefined> => {
  const resolved = await readFileUpwards(rootPath, boundaryDirectory, ".nvmrc");
  if (!resolved) {
    return {
      severity: "error",
      reason: `missing a .nvmrc file pinning the Node version to at least ${MIN_NODE_MAJOR_VERSION} (for example "${RECOMMENDED_NODE_MAJOR_VERSION}")`,
    };
  }

  const version = firstNonEmptyLine(resolved.content);
  const major = parseNodeMajorVersion(version);
  if (major === undefined) {
    return {
      severity: "error",
      reason: `${resolved.relativePath} must pin a numeric Node version of at least ${MIN_NODE_MAJOR_VERSION} (nvm aliases such as "lts/*" or "node" are not allowed), found: "${version || "<empty>"}"`,
    };
  }

  if (major < MIN_NODE_MAJOR_VERSION) {
    return {
      severity: "error",
      reason: `${resolved.relativePath} pins Node ${version} but the minimum is ${MIN_NODE_MAJOR_VERSION}`,
    };
  }

  if (major < RECOMMENDED_NODE_MAJOR_VERSION) {
    return {
      severity: "warning",
      reason: `${resolved.relativePath} pins Node ${version}; the recommended minimum is ${RECOMMENDED_NODE_MAJOR_VERSION}`,
    };
  }

  return undefined;
};

const validateNpmrc = async (
  rootPath: string,
  boundaryDirectory: string,
): Promise<CheckFinding | undefined> => {
  const resolved = await readFileUpwards(rootPath, boundaryDirectory, ".npmrc");
  if (!resolved) {
    return {
      severity: "error",
      reason: `missing a .npmrc file with "min-release-age=${MIN_DEPENDENCY_AGE_DAYS}" (requires npm v11.10+)`,
    };
  }

  const rawValue = parseMinReleaseAge(resolved.content);
  if (rawValue === undefined) {
    return {
      severity: "error",
      reason: `${resolved.relativePath} must set "min-release-age" to at least ${MIN_DEPENDENCY_AGE_DAYS}, but the setting is not present`,
    };
  }

  const days = Number.parseInt(rawValue, 10);
  if (Number.isNaN(days) || String(days) !== rawValue) {
    return {
      severity: "error",
      reason: `${resolved.relativePath} has an invalid "min-release-age" value: "${rawValue}" (expected an integer number of days)`,
    };
  }

  if (days < MIN_DEPENDENCY_AGE_DAYS) {
    return {
      severity: "error",
      reason: `${resolved.relativePath} sets "min-release-age=${days}" but the minimum is ${MIN_DEPENDENCY_AGE_DAYS} days`,
    };
  }

  return undefined;
};

const projectHasNodeTarget = (project: Project): boolean =>
  project.targets.some((target) => target.ecosystem === "node");

export const findNodeConfigViolations = async (
  projects: Project[],
  boundaryDirectory: string,
): Promise<ConfigCheckResult> => {
  const nodeProjects = projects.filter(projectHasNodeTarget);

  const entries = await Promise.all(
    nodeProjects.map(async (project) => {
      const findings = (
        await Promise.all([
          validateNvmrc(project.rootPath, boundaryDirectory),
          validateNpmrc(project.rootPath, boundaryDirectory),
        ])
      ).filter((finding): finding is CheckFinding => finding !== undefined);

      return { relativePath: project.relativePath, findings };
    }),
  );

  return collectFindings(entries);
};
