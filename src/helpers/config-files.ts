import { promises as fs } from "node:fs";
import path from "node:path";

export const MIN_DEPENDENCY_AGE_DAYS = 3;

export interface ConfigViolation {
  reasons: string[];
  relativePath: string;
}

export interface ConfigCheckResult {
  violations: ConfigViolation[];
  warnings: ConfigViolation[];
}

export type CheckSeverity = "error" | "warning";

export interface CheckFinding {
  severity: CheckSeverity;
  reason: string;
}

export interface ResolvedConfigFile {
  content: string;
  relativePath: string;
}

export const firstNonEmptyLine = (content: string): string =>
  content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0) ?? "";

export const collectFindings = (
  entries: Array<{ relativePath: string; findings: CheckFinding[] }>,
): ConfigCheckResult => {
  const bySeverity = (severity: CheckSeverity): ConfigViolation[] =>
    entries
      .map(({ relativePath, findings }) => ({
        relativePath,
        reasons: findings
          .filter((finding) => finding.severity === severity)
          .map((finding) => finding.reason),
      }))
      .filter((entry) => entry.reasons.length > 0);

  return {
    violations: bySeverity("error"),
    warnings: bySeverity("warning"),
  };
};

export const ancestorChain = (
  startDir: string,
  boundaryDir: string,
): string[] => {
  const boundary = path.resolve(boundaryDir);
  const start = path.resolve(startDir);
  const relative = path.relative(boundary, start);

  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    return [start];
  }

  const segments = relative === "" ? [] : relative.split(path.sep);
  return [
    boundary,
    ...segments.map((_, index) =>
      path.join(boundary, ...segments.slice(0, index + 1)),
    ),
  ].reverse();
};

export const readFileIfExists = async (
  filePath: string,
): Promise<string | undefined> => {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch {
    return undefined;
  }
};

export const fileExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

export const readFileUpwards = async (
  startDir: string,
  boundaryDir: string,
  fileName: string,
): Promise<ResolvedConfigFile | undefined> => {
  const candidates = ancestorChain(startDir, boundaryDir).map((directory) =>
    path.join(directory, fileName),
  );

  for (const candidate of candidates) {
    const content = await readFileIfExists(candidate);
    if (content !== undefined) {
      return {
        content,
        relativePath: path.relative(boundaryDir, candidate) || fileName,
      };
    }
  }

  return undefined;
};
