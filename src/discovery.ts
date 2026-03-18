import { promises as fs } from "node:fs";
import path from "node:path";

import { Project, ProjectTarget, RepoMode } from "./types";

const TERRAFORM_DIRECTORIES = new Set(["tf", "module"]);

const IGNORED_DIRECTORIES = new Set([
  ".git",
  ".hg",
  ".next",
  ".nuxt",
  ".pnpm-store",
  ".venv",
  ".yarn",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "venv"
]);

interface DiscoverOptions {
  includeRoot: boolean;
  projectDepth?: number;
}

export interface DiscoveryResult {
  misplacedTerraformFiles: string[];
  projects: Project[];
}

export async function discoverProjects(
  workingDirectory: string,
  options: DiscoverOptions
): Promise<DiscoveryResult> {
  const discovered = new Map<string, Project>();
  const misplacedTerraformFiles: string[] = [];
  const maxDepth =
    options.projectDepth === undefined || options.projectDepth < 0
      ? undefined
      : options.projectDepth;

  async function walk(currentDirectory: string, depth: number): Promise<void> {
    const entries = await fs.readdir(currentDirectory, { withFileTypes: true });
    const entryNames = new Set(entries.map((entry) => entry.name));
    const isRoot = path.resolve(currentDirectory) === path.resolve(workingDirectory);
    const withinDepth = maxDepth === undefined || depth <= maxDepth;
    const shouldDiscover = withinDepth && !(isRoot && !options.includeRoot);

    if (shouldDiscover) {
      if (entryNames.has("package.json")) {
        const manifestPath = path.join(currentDirectory, "package.json");
        const packageJson = JSON.parse(await fs.readFile(manifestPath, "utf8")) as {
          scripts?: Record<string, string>;
        };

        addProjectTarget(discovered, workingDirectory, currentDirectory, {
          ecosystem: "node",
          manifestPath,
          metadata: {
            scripts: packageJson.scripts ?? {}
          }
        });
      }

      if (entryNames.has("pyproject.toml")) {
        const manifestPath = path.join(currentDirectory, "pyproject.toml");
        const pyprojectContent = await fs.readFile(manifestPath, "utf8");

        addProjectTarget(discovered, workingDirectory, currentDirectory, {
          ecosystem: "python",
          manifestPath,
          metadata: {
            hasRuff: detectPythonRuff(pyprojectContent)
          }
        });
      }
    }

    const relativeToCwd = path.relative(workingDirectory, currentDirectory);
    const isInsideTerraformDirectory = relativeToCwd
      .split(path.sep)
      .some((segment) => TERRAFORM_DIRECTORIES.has(segment));

    if (!isRoot && !isInsideTerraformDirectory) {
      for (const entry of entries) {
        if (!entry.isDirectory() && entry.name.endsWith(".tf")) {
          misplacedTerraformFiles.push(
            normalizeRelativePath(workingDirectory, path.join(currentDirectory, entry.name))
          );
        }
      }
    }

    if (maxDepth !== undefined && depth >= maxDepth) {
      return;
    }

    for (const entry of entries) {
      if (!entry.isDirectory()) {
        continue;
      }

      if (IGNORED_DIRECTORIES.has(entry.name)) {
        continue;
      }

      if (TERRAFORM_DIRECTORIES.has(entry.name)) {
        if (withinDepth) {
          const tfDirectory = path.join(currentDirectory, entry.name);
          if (await hasTerraformFiles(tfDirectory)) {
            addProjectTarget(discovered, workingDirectory, tfDirectory, {
              ecosystem: "terraform",
              manifestPath: tfDirectory,
              metadata: {}
            });
          }
        }
        continue;
      }

      await walk(path.join(currentDirectory, entry.name), depth + 1);
    }
  }

  await walk(workingDirectory, 0);

  return {
    misplacedTerraformFiles: misplacedTerraformFiles.sort(),
    projects: Array.from(discovered.values()).sort((left, right) =>
      left.relativePath.localeCompare(right.relativePath)
    )
  };
}

export function detectRepoMode(projects: Project[]): RepoMode {
  if (projects.length === 0) {
    return "empty";
  }

  if (projects.length === 1) {
    return "single-project";
  }

  return "monorepo";
}

export function detectPythonRuff(pyprojectContent: string): boolean {
  return (
    /\[tool\.ruff(?:\.|])/m.test(pyprojectContent) ||
    /\bruff\b/m.test(pyprojectContent)
  );
}

function addProjectTarget(
  discovered: Map<string, Project>,
  workingDirectory: string,
  projectRoot: string,
  target: ProjectTarget
): void {
  const absoluteRoot = path.resolve(projectRoot);
  const existing = discovered.get(absoluteRoot);

  if (existing) {
    existing.targets.push(target);
    return;
  }

  const relativePath = normalizeRelativePath(workingDirectory, projectRoot);
  discovered.set(absoluteRoot, {
    rootPath: absoluteRoot,
    relativePath,
    targets: [target]
  });
}

async function hasTerraformFiles(directory: string): Promise<boolean> {
  try {
    const entries = await fs.readdir(directory);
    return entries.some((entry) => entry.endsWith(".tf"));
  } catch {
    return false;
  }
}

function normalizeRelativePath(from: string, to: string): string {
  const relative = path.relative(from, to);

  if (!relative) {
    return ".";
  }

  return relative.split(path.sep).join(path.posix.sep);
}
