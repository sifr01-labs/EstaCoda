export type OperatorConsoleInputSurface =
  | "taskInspection"
  | "approval"
  | "typeahead"
  | "attachment"
  | "prompt";

/** One canonical precedence chain for interactive session input. */
export function resolveOperatorConsoleInputSurface(input: {
  readonly taskInspection: boolean;
  readonly approval: boolean;
  readonly typeahead: boolean;
  readonly attachment: boolean;
}): OperatorConsoleInputSurface {
  if (input.taskInspection) return "taskInspection";
  if (input.approval) return "approval";
  if (input.typeahead) return "typeahead";
  if (input.attachment) return "attachment";
  return "prompt";
}
