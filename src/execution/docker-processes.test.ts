import { expect, it, vi } from "vitest";
import type { DockerContainer } from "./docker-container.js";
import { DockerProcessScope } from "./docker-processes.js";
it("does not inherit host credentials or accept arbitrary environment injection", async () => {
  const client = { run: vi.fn() };
  const scope = new DockerProcessScope({ workspace: { canonicalPath: "/" }, client } as unknown as DockerContainer);
  expect(scope.environment()).toEqual({ HOME: "/tmp", TMPDIR: "/tmp", PATH: "/usr/local/bin:/usr/bin:/bin", LANG: "C.UTF-8", PYTHONDONTWRITEBYTECODE: "1" });
  expect(() => scope.environment({ extra: { AWS_SECRET_ACCESS_KEY: "example" } })).toThrow("not configured");
  expect(() => scope.spawn("echo", [], { env: { NODE_OPTIONS: "--require=/outside" } })).toThrow("unapproved");
  await scope.terminate({} as never);
  expect(client.run).not.toHaveBeenCalled();
  await scope.release();
  expect(() => scope.spawn("echo", [])).toThrow("released");
});
