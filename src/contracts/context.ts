export type ContextReferenceKind = "file" | "folder";

export type ContextReferenceStatus = "included" | "blocked" | "missing" | "truncated";

export type ContextReference = {
  raw: string;
  kind: ContextReferenceKind;
  target: string;
  lineStart?: number;
  lineEnd?: number;
};

export type ContextBlock = {
  source: string;
  kind: ContextReferenceKind | "project-file";
  title: string;
  content: string;
  status: ContextReferenceStatus | "loaded";
  bytes: number;
  warnings: string[];
};

export type ContextExpansionResult = {
  originalText: string;
  expandedText: string;
  references: ContextReference[];
  blocks: ContextBlock[];
  warnings: string[];
};

export type ContextReferenceExpanderOptions = {
  workspaceRoot: string;
  maxFileBytes?: number;
  maxFolderEntries?: number;
  maxTotalBytes?: number;
};

export type ProjectContextFile = {
  path: string;
  label: string;
  priority: number;
  compatibility: boolean;
};

export type ProjectContextLoadOptions = {
  workspaceRoot: string;
  maxFileBytes?: number;
  maxTotalBytes?: number;
};

export type ProjectContextSnapshot = {
  workspaceRoot: string;
  files: ContextBlock[];
  warnings: string[];
};
