import { promises as fs } from "node:fs";
import path from "node:path";

export const MIN_DEPENDENCY_AGE_DAYS = 3;

export interface ConfigViolation {
  reasons: string[];
  relativePath: string;
}

export interface ResolvedConfigFile {
  content: string;
  relativePath: string;
}

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
