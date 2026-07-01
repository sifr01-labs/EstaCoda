import { renderDoctorSurface } from "../ui/papyrus/operator-console/doctorSurface.js";
import type { DoctorReport } from "./types.js";

export function renderDoctorReport(report: DoctorReport): string {
  return renderDoctorSurface(report);
}

export function renderDoctorJsonReport(report: DoctorReport): string {
  return `${JSON.stringify(report, null, 2)}\n`;
}
