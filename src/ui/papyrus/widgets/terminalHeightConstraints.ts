export type TerminalHeightConstraintInput = {
  readonly availableHeight: number;
  readonly searchRows?: number;
  readonly hintRows?: number;
  readonly statusRows?: number;
  readonly listMinRows?: number;
  readonly listMaxRows?: number;
  readonly previewEnabled?: boolean;
  readonly previewMinRows?: number;
  readonly previewPreferredRows?: number;
  readonly previewMaxRows?: number;
};

export type TerminalHeightConstraintResult = {
  readonly availableHeight: number;
  readonly searchRows: number;
  readonly hintRows: number;
  readonly statusRows: number;
  readonly listRows: number;
  readonly previewRows: number;
  readonly contentRows: number;
  readonly usedRows: number;
  readonly overflowRows: number;
};

export function calculateTerminalHeightConstraints(
  input: TerminalHeightConstraintInput
): TerminalHeightConstraintResult {
  const availableHeight = normalizeRows(input.availableHeight);
  const searchRows = clampFixedRows(input.searchRows ?? 1, availableHeight);
  const remainingAfterSearch = Math.max(0, availableHeight - searchRows);
  const hintRows = clampFixedRows(input.hintRows ?? 0, remainingAfterSearch);
  const remainingAfterHints = Math.max(0, remainingAfterSearch - hintRows);
  const statusRows = clampFixedRows(input.statusRows ?? 0, remainingAfterHints);
  const contentRows = Math.max(0, availableHeight - searchRows - hintRows - statusRows);

  const listMinRows = normalizeRows(input.listMinRows ?? 1);
  const listMaxRows = normalizeOptionalMaxRows(input.listMaxRows);
  const previewEnabled = input.previewEnabled ?? false;
  const previewMinRows = previewEnabled ? normalizeRows(input.previewMinRows ?? 0) : 0;
  const previewPreferredRows = previewEnabled
    ? normalizeRows(input.previewPreferredRows ?? Math.floor(contentRows / 2))
    : 0;
  const previewMaxRows = previewEnabled ? normalizeOptionalMaxRows(input.previewMaxRows) : 0;

  const reservedListRows = Math.min(contentRows, listMinRows, listMaxRows);
  const maxPreviewRows = previewEnabled
    ? Math.min(previewMaxRows, Math.max(0, contentRows - reservedListRows))
    : 0;
  const previewRows = previewEnabled
    ? Math.min(maxPreviewRows, Math.max(Math.min(previewMinRows, maxPreviewRows), previewPreferredRows))
    : 0;
  const listRows = Math.min(listMaxRows, Math.max(0, contentRows - previewRows));
  const usedRows = searchRows + hintRows + statusRows + listRows + previewRows;

  return {
    availableHeight,
    searchRows,
    hintRows,
    statusRows,
    listRows,
    previewRows,
    contentRows,
    usedRows,
    overflowRows: Math.max(0, usedRows - availableHeight),
  };
}

export function calculatePickerPreviewLayout(input: TerminalHeightConstraintInput): {
  readonly pickerViewportHeight: number;
  readonly previewViewportHeight: number;
  readonly constraints: TerminalHeightConstraintResult;
} {
  const constraints = calculateTerminalHeightConstraints(input);
  return {
    pickerViewportHeight: constraints.listRows,
    previewViewportHeight: constraints.previewRows,
    constraints,
  };
}

function normalizeRows(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.floor(value));
}

function normalizeOptionalMaxRows(value: number | undefined): number {
  if (value === undefined || !Number.isFinite(value)) return Number.MAX_SAFE_INTEGER;
  return Math.max(0, Math.floor(value));
}

function clampFixedRows(value: number, availableRows: number): number {
  return Math.min(normalizeRows(value), Math.max(0, availableRows));
}
