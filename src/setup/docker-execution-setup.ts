import type { Prompt } from "../cli/prompt-contract.js";
import type { SetupCopyLocale } from "./setup-copy.js";
import { promptSetupChoice } from "./setup-prompts.js";
import { probeDocker } from "../execution/docker-client.js";

export async function promptExecutionSetup(prompt: Prompt, locale: SetupCopyLocale) {
  const ar = locale === "ar";
  const mode = await promptSetupChoice(prompt, { title: ar ? "بيئة التنفيذ" : "Execution environment", message: ar ? "اختر صلاحية تنفيذ العمل." : "Choose where workspace work may execute.", defaultValue: "host",
    choices: [{ id: "host", value: "host", label: ar ? "محلي" : "Local host" }, { id: "docker", value: "docker", label: ar ? "داخل حاوية" : "Sandboxed (Docker)" }, { id: "back", value: "back", label: ar ? "رجوع" : "Back" }] });
  if (mode === "back") return undefined;
  if (mode === "host") return { executionBackend: "host", workspaceAccess: "read-write", commandNetwork: "unrestricted", imagePreparation: "Not needed" };
  const probe = await probeDocker();
  if (!probe.available) throw new Error(probe.blocker);
  const workspaceAccess = await promptSetupChoice(prompt, { title: ar ? "الوصول إلى ملفات العمل" : "Workspace access", message: ar ? "الكتابة تعدل ملفات مساحة العمل على الجهاز." : "Writable access changes the mounted host workspace.", defaultValue: "read-only",
    choices: [{ id: "ro", value: "read-only", label: ar ? "قراءة فقط" : "Read only" }, { id: "rw", value: "read-write", label: ar ? "قراءة وكتابة" : "Read and write" }] });
  const commandNetwork = await promptSetupChoice(prompt, { title: ar ? "شبكة الأوامر" : "Command networking", message: ar ? "الاتصال المباشر قد يصل إلى الشبكات الداخلية." : "Direct networking can reach private networks. Provider traffic remains governed on the host.", defaultValue: "disabled",
    choices: [{ id: "none", value: "disabled", label: ar ? "معطلة" : "Disabled" }, { id: "direct", value: "unrestricted", label: ar ? "اتصال مباشر" : "Direct network" }] });
  return { executionBackend: "docker", workspaceAccess, commandNetwork, imageId: probe.imageId,
    buildImage: !probe.imageId, imagePreparation: probe.imageId ? "Reuse prepared image" : "Build bundled image and download its dependencies during apply" };
}
