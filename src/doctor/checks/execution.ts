import { selectedExecutionPolicy } from "../../execution/docker-policy.js";
import { DockerClient } from "../../execution/docker-client.js";
import { verifyHostExecution } from "../../execution/host-authority.js";
import { WorkspaceTrustStore } from "../../security/workspace-trust-store.js";
import type { DoctorCheck, DoctorLocale } from "../types.js";

/** Read-only readiness, never an execution lease or approval grant. */
export async function diagnoseExecution(input: { homeDir?: string; profileId: string; workspaceRoot: string; locale: DoctorLocale },
  connect: typeof DockerClient.connect = () => DockerClient.connect()): Promise<DoctorCheck> {
  const ar = input.locale === "ar";
  const result = (severity: DoctorCheck["severity"], en: string, arabic: string): DoctorCheck => ({
    id: "execution", label: ar ? "بيئة التنفيذ" : "Execution environment", severity, summary: ar ? arabic : en
  });
  try {
    const policy = await selectedExecutionPolicy(input);
    if (!await new WorkspaceTrustStore(input).isTrusted(input.workspaceRoot)) return result("blocked",
      "Workspace trust is required. Review this directory in local setup before running work.",
      "يلزم الوثوق بمجلد العمل. راجع المجلد في الإعداد المحلي قبل التنفيذ.");
    if (policy.backend === "host") {
      const facts = await verifyHostExecution(input.workspaceRoot, policy);
      return facts.advisoryDegradations.length ? result("warning",
        "Local host cannot enforce requested advisory controls. Review execution settings; host files and network remain accessible.",
        "لا يستطيع المضيف المحلي فرض القيود الاستشارية المطلوبة. راجع إعدادات التنفيذ؛ تظل ملفات المضيف والشبكة متاحة.") : result("healthy",
        "Local host: filesystem and command network are not sandboxed. Trust and tool approvals still apply.",
        "المضيف المحلي: الملفات وشبكة الأوامر غير معزولة. تظل الثقة وموافقات الأدوات مطلوبة.");
    }
    const client = await connect();
    const info = JSON.parse(await client.run(["info", "--format", "{{json .}}"], 5000));
    const image = JSON.parse(await client.run(["image", "inspect", policy.imageId!], 5000))[0];
    if (info.OSType !== "linux" || String(info.CgroupVersion) !== "2" || !info.SecurityOptions?.some((v: string) => v.startsWith("name=seccomp")) ||
      image?.Id !== policy.imageId || image.Config?.Labels?.["io.estacoda.execution.version"] !== "1") throw new Error("unavailable");
    return result("info", "Docker engine and selected image are available. Container controls are verified on acquisition; no container was started. Tool approvals remain separate.",
      "محرك Docker والصورة المحددة متاحان. تُفحص قيود الحاوية عند بدء التنفيذ؛ لم تُشغّل حاوية. موافقات الأدوات مستقلة.");
  } catch {
    return result("blocked", "Execution policy, workspace or selected Docker engine/image could not be verified. Review Execution in Setup Editor and retry. No host fallback is allowed.",
      "تعذر التحقق من سياسة التنفيذ أو مجلد العمل أو محرك Docker وصورته. راجع التنفيذ في محرر الإعداد وأعد المحاولة. لا يُسمح بالرجوع التلقائي إلى المضيف.");
  }
}
