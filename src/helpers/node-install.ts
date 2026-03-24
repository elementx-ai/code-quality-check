import { promises as fs } from "node:fs";
import path from "node:path";

const pathExists = async (filePath: string): Promise<boolean> => {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
};

const hasNodeLockfile = async (directory: string): Promise<boolean> => {
  if (await pathExists(path.join(directory, "package-lock.json"))) {
    return true;
  }

  return pathExists(path.join(directory, "npm-shrinkwrap.json"));
};

const hasWorkspaces = (
  workspaces: string[] | { packages?: string[] } | undefined,
): boolean => {
  if (Array.isArray(workspaces)) {
    return workspaces.length > 0;
  }

  return Array.isArray(workspaces?.packages) && workspaces.packages.length > 0;
};

export const shouldUseRootWorkspaceInstall = async (
  workingDirectory: string,
): Promise<boolean> => {
  const packageJsonPath = path.join(workingDirectory, "package.json");
  if (
    !(await pathExists(packageJsonPath)) ||
    !(await hasNodeLockfile(workingDirectory))
  ) {
    return false;
  }

  const packageJson = JSON.parse(
    await fs.readFile(packageJsonPath, "utf8"),
  ) as {
    workspaces?: string[] | { packages?: string[] };
  };

  return hasWorkspaces(packageJson.workspaces);
};

export { hasNodeLockfile };
