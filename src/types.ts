export type Ecosystem = "node" | "python" | "terraform";

export type RepoMode = "empty" | "single-project" | "monorepo";

export interface NodeTargetMetadata {
  scripts: Record<string, string>;
}

export interface PythonTargetMetadata {
  hasRuff: boolean;
}

export type TerraformTargetMetadata = Record<string, never>;

export type NodeProjectTarget = {
  ecosystem: "node";
  manifestPath: string;
  metadata: NodeTargetMetadata;
};

export type PythonProjectTarget = {
  ecosystem: "python";
  manifestPath: string;
  metadata: PythonTargetMetadata;
};

export type TerraformProjectTarget = {
  ecosystem: "terraform";
  manifestPath: string;
  metadata: TerraformTargetMetadata;
};

export type ProjectTarget =
  | NodeProjectTarget
  | PythonProjectTarget
  | TerraformProjectTarget;

export interface Project {
  rootPath: string;
  relativePath: string;
  targets: ProjectTarget[];
}
