import { hostAuthorityFingerprint } from "./host-authority.js";
import { dockerAuthorityFingerprint, type DockerExecutionFacts } from "./docker-container.js";
import type { HostExecutionFacts } from "../contracts/execution-authority.js";
export type ExecutionFacts = HostExecutionFacts | DockerExecutionFacts;
export function executionAuthorityFingerprint(facts: Readonly<ExecutionFacts>): string {
  return facts.backend === "docker" ? dockerAuthorityFingerprint(facts) : hostAuthorityFingerprint(facts);
}
