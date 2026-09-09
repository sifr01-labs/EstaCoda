import { expect, it } from "vitest";
import { hostAuthorityFingerprint, isVerifiedHostExecution, verifyHostExecution } from "./host-authority.js";

it("reports host capabilities honestly and does not accept forged or deserialized facts", async () => {
  const facts = await verifyHostExecution(process.cwd());
  expect(facts).toMatchObject({ backend: "host", filesystemContainment: false, networkContainment: false, limits: "unverified", credentialIsolation: "unverified-inherited-environment" });
  expect(isVerifiedHostExecution(facts)).toBe(true);
  expect(isVerifiedHostExecution(JSON.parse(JSON.stringify(facts)))).toBe(false);
  expect(() => hostAuthorityFingerprint({ ...facts })).toThrow("not verified");
  expect(Object.isFrozen(facts.workspace)).toBe(true);
});
it("blocks mandatory unsupported controls and records advisory degradation without privilege", async () => {
  await expect(verifyHostExecution(process.cwd(), { backend: "host", commandNetwork: { value: "disabled", requirement: "mandatory" } })).rejects.toThrow("mandatory commandNetwork");
  const facts = await verifyHostExecution(process.cwd(), { backend: "host", workspaceAccess: { value: "read-only", requirement: "advisory" } });
  expect(facts.workspaceAccess).toBe("read-write");
  expect(facts.advisoryDegradations).toHaveLength(1);
  expect(hostAuthorityFingerprint(facts)).toBe(hostAuthorityFingerprint(await verifyHostExecution(process.cwd())));
  await expect(verifyHostExecution(process.cwd(), { backend: "docker" } as never)).rejects.toThrow("fallback");
});
