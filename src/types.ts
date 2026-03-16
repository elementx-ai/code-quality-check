export type Ecosystem = "node" | "python";

export type RepoMode = "empty" | "single-project" | "monorepo";

export interface NodeTargetMetadata {
  scripts: Record<string, string>;
}

export interface PythonTargetMetadata {
  hasRuff: boolean;
}

export interface ProjectTarget {
  ecosystem: Ecosystem;
  manifestPath: string;
  metadata: NodeTargetMetadata | PythonTargetMetadata;
}

export interface Project {
  rootPath: string;
  relativePath: string;
  targets: ProjectTarget[];
}
