import { renderDoctorFixSurface } from "../ui/papyrus/operator-console/doctorFixSurface.js";
import type { DoctorFixResult } from "./fix-engine.js";

export function renderDoctorFixReport(result: DoctorFixResult): string {
  return renderDoctorFixSurface(result);
}
