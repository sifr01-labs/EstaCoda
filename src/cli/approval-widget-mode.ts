export const APPROVAL_WIDGET_MODE_ENV_VAR = "ESTACODA_APPROVAL_WIDGETS";

export const APPROVAL_WIDGET_MODES = ["papyrus"] as const;

export type ApprovalWidgetMode = typeof APPROVAL_WIDGET_MODES[number];

export type ResolveApprovalWidgetModeOptions = {
  env?: Record<string, string | undefined>;
  defaultMode?: ApprovalWidgetMode;
};

export type ResolveCoreSessionApprovalWidgetModeOptions = Omit<ResolveApprovalWidgetModeOptions, "defaultMode"> & {
  inputMode: "raw";
  rendererMode: "papyrus";
};

export function parseApprovalWidgetMode(
  value: string | undefined,
  defaultMode: ApprovalWidgetMode = "papyrus"
): ApprovalWidgetMode {
  const normalized = value?.trim().toLowerCase();
  if (normalized === "papyrus") return "papyrus";
  return defaultMode;
}

export function resolveApprovalWidgetMode(options?: ResolveApprovalWidgetModeOptions): ApprovalWidgetMode {
  const env = options?.env ?? process.env;
  return parseApprovalWidgetMode(env[APPROVAL_WIDGET_MODE_ENV_VAR], options?.defaultMode);
}

export function resolveCoreSessionApprovalWidgetMode(
  _options: ResolveCoreSessionApprovalWidgetModeOptions
): ApprovalWidgetMode {
  return "papyrus";
}
