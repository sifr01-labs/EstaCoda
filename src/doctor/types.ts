export type LiveToolDiagnostic = {
  status: "ready" | "blocked";
  lines: string[];
  warnings: string[];
};
