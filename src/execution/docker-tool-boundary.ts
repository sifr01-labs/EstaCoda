import type { RuntimeToolAdmissionGuard } from "../tools/tool-executor.js";
// Reviewed built-ins that use the selected lease or bounded runtime bookkeeping.
// Registration remains visible; a connector or new host tool never inherits this authority.
const contained = new Set(["file.read", "file.write", "file.patch", "file.search", "file.grep", "file.glob", "notebook.edit",
  "terminal.run", "terminal.inspect", "process.start", "process.input", "process.list", "process.logs", "process.stop", "execute_code",
  "python.probe", "document.probe", "plan", "task.status", "trajectory.record", "delegate_task"]);
export const dockerToolAdmissionGuard: RuntimeToolAdmissionGuard = ({ tool }) => {
  if (!tool.connector && contained.has(tool.name)) return undefined;
  return { code: "docker_host_capability_unavailable", reason: "This tool uses host capabilities outside the Docker lease. Select Local execution through Setup Editor for an explicitly authorized host workflow. Direct Docker networking does not authorize host tools." };
};
