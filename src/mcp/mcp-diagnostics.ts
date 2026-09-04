import { redactSensitiveText } from "../utils/redaction.js";
import type { MCPServerSnapshot } from "./mcp-tools.js";

/** Bounded diagnostics, never connector configuration or raw credential values. */
export function sanitizeMcpDiagnostic(text: string, secrets: readonly string[] = []): string {
  for (const secret of [...secrets].filter(Boolean).sort((a, b) => b.length - a.length)) {
    text = text.split(secret).join("[REDACTED]");
  }
  return redactSensitiveText(text)
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/[\x00-\x1f\x7f]/gu, " ")
    .replace(/(?:\/Users\/|\/home\/|\/private\/|\/var\/|[A-Za-z]:\\)[^\s"']+/gu, "[local path]")
    .replace(/\s+/gu, " ").trim().slice(0, 1200);
}

export function mcpFailureDiagnostics(snapshots: readonly MCPServerSnapshot[]): string[] {
  return snapshots.filter((server) => server.enabled && !server.available).map((server) =>
    `${sanitizeMcpDiagnostic(server.name)}: ${server.failureStage ?? "availability"}: ${sanitizeMcpDiagnostic(server.error ?? "No callable tools are available.")}`
  );
}

export function mcpRecoveryGuidance(locale: "en" | "ar" = "en"): string {
  return locale === "ar"
    ? "المهمة محفوظة. لإعادة الاتصال مرة واحدة استخدم ⁦/reload-mcp⁩. إذا كان إعداد الاعتماد ناقصًا، حدّثه عبر إعدادات الملف الشخصي الآمنة؛ لا تلصق الأسرار في المحادثة. بعد نجاح الاتصال اطلب متابعة المهمة."
    : "Your task is saved. Would you like to retry the configured connection? Use /reload-mcp for one attempt (/reload-mcp status shows CLI diagnostics without reconnecting). If credentials or configuration are missing, repair them through secure profile setup; do not paste secrets into chat. Once connected, ask to continue the task.";
}
