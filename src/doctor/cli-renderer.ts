import { renderDoctorSurface } from "../ui/papyrus/operator-console/doctorSurface.js";
import type { OperatorConsoleStyle } from "../ui/papyrus/operator-console/operatorConsoleStyle.js";
import type { DoctorReport } from "./types.js";

export type DoctorReportRenderOptions = {
  readonly style?: OperatorConsoleStyle;
};

export function renderDoctorReport(report: DoctorReport, options: DoctorReportRenderOptions = {}): string {
  return renderDoctorSurface(report, options);
}

export function renderDoctorJsonReport(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
