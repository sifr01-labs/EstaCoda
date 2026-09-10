import { expect, it } from "vitest";
import { dockerToolAdmissionGuard } from "./docker-tool-boundary.js";
const check = (name: string, connector?: any) => dockerToolAdmissionGuard({ tool: { name, connector } as any, input: {}, executionEffect: undefined });
it("keeps contained tools callable and refuses host/network bridges, including named connectors", () => {
  for (const name of ["terminal.run", "file.read", "execute_code", "process.start", "document.probe"]) expect(check(name)).toBeUndefined();
  for (const name of ["web.search", "browser.navigate", "config.set", "unknown", "terminal.inspect", "artifact.export"]) expect(check(name)?.code).toBe("docker_host_capability_unavailable");
  expect(check("file.read", { kind: "mcp", id: "server" })).toBeDefined();
});
