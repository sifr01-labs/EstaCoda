import { describe, expect, it, vi } from "vitest";
import type { ForegroundExecutionCheckpoint } from "../contracts/execution-checkpoint.js";
import type { ExecutionPlanCapabilityRequirement } from "../contracts/execution-plan.js";
import type { SkillDefinition } from "../contracts/skill.js";
import type { RegisteredTool, ToolRiskClass, ToolsetName } from "../contracts/tool.js";
import { ToolRegistry } from "../tools/tool-registry.js";
import {
  ExecutionCapabilityPreflight,
  formatCheckpointResumeBlocker,
  formatExecutionCapabilityBlocker,
  formatGovernedTransferBlocker
} from "./execution-capability-preflight.js";

function tool(input: {
  name: string;
  riskClass: ToolRiskClass;
  available?: boolean;
  protectedPaths?: string[];
  groupedDelivery?: boolean;
  protectedSources?: "browser"[];
  verifies?: string[];
  connectorId?: string;
  artifactPaths?: string[];
  redactedResultPaths?: string[];
  toolsets?: ToolsetName[];
  run?: RegisteredTool["run"];
}): RegisteredTool {
  return {
    name: input.name,
    description: "test tool",
    inputSchema: { type: "object" },
    riskClass: input.riskClass,
    toolsets: input.toolsets ?? ["mcp"],
    ...(input.connectorId === undefined ? {} : { connector: { kind: "mcp" as const, id: input.connectorId } }),
    progressLabel: "testing",
    maxResultSizeChars: 100,
    protectedArguments: input.protectedPaths?.map((path) => ({
      path,
      handling: { persistence: "destination-managed", sharing: "workspace" }
    })),
    ...(
      input.protectedPaths === undefined && input.verifies === undefined &&
        input.artifactPaths === undefined && input.redactedResultPaths === undefined
        ? {}
        : {
            capabilityMetadata: {
              ...(input.protectedPaths === undefined ? {} : {
                protectedInput: {
                  groupedDelivery: input.groupedDelivery ?? true,
                  sources: input.protectedSources ?? ["browser"]
                }
              }),
              ...(input.verifies === undefined ? {} : { verification: { verifies: input.verifies } }),
              ...(input.artifactPaths === undefined ? {} : { artifactInput: { paths: input.artifactPaths } }),
              ...(input.redactedResultPaths === undefined ? {} : {
                resultRedaction: { paths: input.redactedResultPaths }
              })
            }
          }
    ),
    isAvailable: () => input.available ?? true,
    run: input.run ?? vi.fn(async () => ({ ok: true, content: "must not run" }))
  };
}

const requirements: ExecutionPlanCapabilityRequirement[] = [
  { id: "read-target", itemId: "inspect", tool: "mcp.target.read", capability: "read" },
  {
    id: "mutate-target",
    itemId: "update",
    tool: "mcp.target.update",
    capability: "mutate",
    requiresProtectedInput: true,
    protectedSource: "browser"
  },
  { id: "verify-target", itemId: "verify", tool: "mcp.target.verify", capability: "verify" }
];

describe("ExecutionCapabilityPreflight", () => {
  it("marks bounded read, mutation, protected transfer, and independent verification requirements ready", async () => {
    const registry = new ToolRegistry();
    const runs = Array.from({ length: 3 }, () => vi.fn(async () => ({ ok: true, content: "unused" })));
    registry.register(tool({ name: "mcp.target.read", riskClass: "read-only-network", run: runs[0] }));
    registry.register(tool({
      name: "mcp.target.update",
      riskClass: "external-side-effect",
      protectedPaths: ["/entries/*/value", "/metadata/secret"],
      run: runs[1]
    }));
    registry.register(tool({ name: "mcp.target.verify", riskClass: "read-only-network", run: runs[2] }));
    const browserSourceAvailable = vi.fn(async () => true);

    const result = await new ExecutionCapabilityPreflight({ registry, browserSourceAvailable }).assess(requirements, {
      protectedTransferAvailable: true,
      groupedProtectedTransferAvailable: true
    });

    expect(result).toMatchObject({
      status: "ready",
      assessments: [
        {
          requirementId: "read-target",
          status: "ready",
          resolution: { canonicalTool: "mcp.target.read", riskClass: "read-only-network", classification: "read" }
        },
        {
          requirementId: "mutate-target",
          status: "ready",
          resolution: {
            canonicalTool: "mcp.target.update",
            riskClass: "external-side-effect",
            classification: "mutate",
            protectedInput: {
              paths: ["/entries/*/value", "/metadata/secret"],
              grouped: true,
              source: "browser"
            }
          }
        },
        {
          requirementId: "verify-target",
          status: "ready",
          resolution: {
            verification: { mutationTools: ["mcp.target.update"] }
          }
        }
      ]
    });
    expect(browserSourceAvailable).toHaveBeenCalledOnce();
    expect(runs.every((run) => run.mock.calls.length === 0)).toBe(true);
  });

  it("distinguishes missing, unavailable, undeclared protected paths, and incompatible risk", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "unavailable.update", riskClass: "external-side-effect", available: false }));
    registry.register(tool({ name: "unprotected.update", riskClass: "external-side-effect" }));
    registry.register(tool({ name: "readonly.update", riskClass: "read-only-network" }));
    const preflight = new ExecutionCapabilityPreflight({ registry });

    await expect(preflight.assess([
      { id: "missing", itemId: "one", tool: "absent.update", capability: "mutate" },
      { id: "unavailable", itemId: "two", tool: "unavailable.update", capability: "mutate" },
      {
        id: "path",
        itemId: "three",
        tool: "unprotected.update",
        capability: "mutate",
        requiresProtectedInput: true
      },
      { id: "risk", itemId: "four", tool: "readonly.update", capability: "mutate" }
    ], { protectedTransferAvailable: true })).resolves.toEqual({
      status: "blocked",
      assessments: [
        expect.objectContaining({ requirementId: "missing", status: "missing", reasonCode: "tool_missing" }),
        expect.objectContaining({ requirementId: "unavailable", status: "unavailable", reasonCode: "tool_unavailable" }),
        expect.objectContaining({ requirementId: "path", status: "incompatible", reasonCode: "protected_path_missing" }),
        expect.objectContaining({ requirementId: "risk", status: "incompatible", reasonCode: "risk_mismatch" })
      ]
    });
  });

  it("requires verification to use a different read-safe tool than mutation", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "target.change", riskClass: "external-side-effect" }));
    const result = await new ExecutionCapabilityPreflight({ registry }).assess([
      { id: "change", itemId: "change", tool: "target.change", capability: "mutate" },
      { id: "verify", itemId: "verify", tool: "target.change", capability: "verify" }
    ]);
    expect(result.assessments[1]).toMatchObject({ status: "incompatible", reasonCode: "risk_mismatch" });
  });

  it("fails closed when protected or browser-source transfer is unavailable", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({
      name: "target.change",
      riskClass: "external-side-effect",
      protectedPaths: ["/values/*/value"]
    }));
    const requirement: ExecutionPlanCapabilityRequirement = {
      id: "change",
      itemId: "change",
      tool: "target.change",
      capability: "mutate",
      requiresProtectedInput: true,
      protectedSource: "browser"
    };
    const preflight = new ExecutionCapabilityPreflight({
      registry,
      browserSourceAvailable: async () => false
    });

    expect((await preflight.assess([requirement], { protectedTransferAvailable: false })).assessments[0])
      .toMatchObject({ status: "unavailable", reasonCode: "protected_transfer_unavailable" });
    expect((await preflight.assess([requirement], {
      protectedTransferAvailable: true,
      groupedProtectedTransferAvailable: true
    })).assessments[0]).toMatchObject({ status: "unavailable", reasonCode: "protected_source_unavailable" });
  });

  it("requires grouped delivery for wildcard protected paths", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({
      name: "target.change",
      riskClass: "external-side-effect",
      protectedPaths: ["/values/*/value"]
    }));
    const result = await new ExecutionCapabilityPreflight({ registry }).assess([{
      id: "change",
      itemId: "change",
      tool: "target.change",
      capability: "mutate",
      requiresProtectedInput: true
    }], {
      protectedTransferAvailable: true,
      groupedProtectedTransferAvailable: false
    });

    expect(result.assessments[0]).toMatchObject({ status: "unavailable", reasonCode: "protected_transfer_unavailable" });
  });

  it("rejects protected mappings that cannot fit in the bounded runtime snapshot", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({
      name: "target.change",
      riskClass: "external-side-effect",
      protectedPaths: Array.from({ length: 9 }, (_, index) => `/secret${index}`)
    }));

    const result = await new ExecutionCapabilityPreflight({ registry }).assess([{
      id: "change",
      itemId: "change",
      tool: "target.change",
      capability: "mutate",
      requiresProtectedInput: true
    }], {
      protectedTransferAvailable: true,
      groupedProtectedTransferAvailable: true
    });

    expect(result.assessments[0]).toMatchObject({
      status: "incompatible",
      reasonCode: "capability_metadata_invalid"
    });
  });

  it("fails closed when registered grouped delivery or browser relay is unsupported", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({
      name: "target.no-group",
      riskClass: "external-side-effect",
      protectedPaths: ["/values/*/value"],
      groupedDelivery: false
    }));
    registry.register(tool({
      name: "target.no-browser",
      riskClass: "external-side-effect",
      protectedPaths: ["/secret"],
      protectedSources: []
    }));
    const preflight = new ExecutionCapabilityPreflight({ registry, browserSourceAvailable: () => true });
    const context = { protectedTransferAvailable: true, groupedProtectedTransferAvailable: true };

    expect((await preflight.assess([{
      id: "group", itemId: "group", tool: "target.no-group", capability: "mutate",
      requiresProtectedInput: true
    }], context)).assessments[0]).toMatchObject({
      status: "incompatible",
      reasonCode: "grouped_transfer_unsupported"
    });
    expect((await preflight.assess([{
      id: "browser", itemId: "browser", tool: "target.no-browser", capability: "mutate",
      requiresProtectedInput: true, protectedSource: "browser"
    }], context)).assessments[0]).toMatchObject({
      status: "incompatible",
      reasonCode: "protected_source_unsupported"
    });
  });

  it("honors registered verification relationships and never infers protected mappings from names", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "target.change", riskClass: "external-side-effect" }));
    registry.register(tool({
      name: "target.verify-other",
      riskClass: "read-only-network",
      verifies: ["other.change"]
    }));
    registry.register(tool({ name: "target.setPassword", riskClass: "external-side-effect" }));
    const preflight = new ExecutionCapabilityPreflight({ registry });

    const verification = await preflight.assess([
      { id: "change", itemId: "change", tool: "target.change", capability: "mutate" },
      { id: "verify", itemId: "verify", tool: "target.verify-other", capability: "verify" }
    ]);
    expect(verification.assessments[1]).toMatchObject({
      status: "incompatible",
      reasonCode: "verification_missing"
    });

    const namedSecret = await preflight.assess([{
      id: "secret", itemId: "secret", tool: "target.setPassword", capability: "mutate",
      requiresProtectedInput: true
    }], { protectedTransferAvailable: true });
    expect(namedSecret.assessments[0]).toMatchObject({
      status: "incompatible",
      reasonCode: "protected_path_missing"
    });
  });

  it("requires registered verification relationships to cover every declared mutation", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "target.change-one", riskClass: "external-side-effect" }));
    registry.register(tool({ name: "target.change-two", riskClass: "external-side-effect" }));
    registry.register(tool({
      name: "target.verify",
      riskClass: "read-only-network",
      verifies: ["target.change-one"]
    }));

    const result = await new ExecutionCapabilityPreflight({ registry }).assess([
      { id: "one", itemId: "one", tool: "target.change-one", capability: "mutate" },
      { id: "two", itemId: "two", tool: "target.change-two", capability: "mutate" },
      { id: "verify", itemId: "verify", tool: "target.verify", capability: "verify" }
    ]);

    expect(result.status).toBe("blocked");
    expect(result.assessments[2]).toMatchObject({
      status: "incompatible",
      reasonCode: "verification_missing"
    });
    expect(result.assessments[2]?.resolution).toBeUndefined();
  });

  it("keeps read-only tools usable without capability metadata and fails closed on missing risk", async () => {
    const registry = new ToolRegistry();
    registry.register(tool({ name: "target.read", riskClass: "read-only-network" }));
    registry.register(tool({ name: "target.no-risk", riskClass: undefined as never }));

    expect((await new ExecutionCapabilityPreflight({ registry }).assess([{
      id: "read", itemId: "read", tool: "target.read", capability: "read"
    }])).assessments[0]).toMatchObject({
      status: "ready",
      resolution: { riskClass: "read-only-network", classification: "read" }
    });
    expect((await new ExecutionCapabilityPreflight({ registry }).assess([{
      id: "risk", itemId: "risk", tool: "target.no-risk", capability: "read"
    }])).assessments[0]).toMatchObject({
      status: "incompatible",
      reasonCode: "risk_class_missing"
    });
  });

  it("assesses only the final filtered registry", async () => {
    const parentRegistry = new ToolRegistry();
    parentRegistry.register(tool({ name: "parent.only.update", riskClass: "external-side-effect" }));
    const childRegistry = new ToolRegistry();
    const child = new ExecutionCapabilityPreflight({ registry: childRegistry });

    const result = await child.assess([
      { id: "child-update", itemId: "update", tool: "parent.only.update", capability: "mutate" }
    ]);

    expect(parentRegistry.get("parent.only.update")).toBeDefined();
    expect(result.assessments[0]).toMatchObject({ status: "missing", reasonCode: "tool_missing" });
  });

  it("renders one precise English or Arabic blocker without secret values", () => {
    const assessment = {
      requirementId: "update",
      itemId: "update",
      tool: "mcp.target.update",
      capability: "mutate" as const,
      status: "incompatible" as const,
      reasonCode: "protected_path_missing" as const
    };
    expect(formatExecutionCapabilityBlocker({ assessment, locale: "en" }))
      .toBe('Tool "mcp.target.update" does not declare the required protected input paths.');
    expect(formatExecutionCapabilityBlocker({ assessment, locale: "ar" }))
      .toBe('الأداة "mcp.target.update" لا تعلن مسارات الإدخال المحمي المطلوبة.');

    const unavailable = {
      ...assessment,
      status: "unavailable" as const,
      reasonCode: "tool_unavailable" as const
    };
    expect(formatExecutionCapabilityBlocker({ assessment: unavailable, locale: "en" }))
      .toBe('Required tool "mcp.target.update" is currently unavailable.');
  });

  it("reports all unavailable checkpoint requirements in one bounded blocker", async () => {
    const skill: SkillDefinition = {
      name: "api-integration",
      description: "Integrate APIs.",
      version: "1",
      whenToUse: [],
      requiredToolsets: ["browser", "mcp"],
      playbook: [],
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };
    const preflight = new ExecutionCapabilityPreflight({
      registry: new ToolRegistry(),
      configuredConnectors: [{
        name: "postman",
        transport: "http",
        configured: true,
        enabled: true,
        connected: false,
        schemasRegistered: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        tools: [],
        capabilities: {
          protectedDeliveryConfigured: true,
          groupedDeliverySupported: true,
          browserRelaySupported: true,
          artifactRelayConfigured: true,
          resultRedactionConfigured: true,
          continuityConfigured: true,
          verificationConfigured: true
        },
        available: false,
        failureStage: "connection"
      }]
    });

    const result = await preflight.assessCheckpointResume({
      checkpoint: checkpoint(),
      selectedSkill: skill
    });

    expect(result).toEqual({
      status: "blocked",
      issues: [
        { kind: "toolset_unavailable", subject: "browser" },
        { kind: "toolset_unavailable", subject: "mcp" },
        { kind: "connector_unavailable", subject: "postman" }
      ]
    });
    if (result.status === "blocked") {
      const message = formatCheckpointResumeBlocker({ result });
      expect(message).toContain('required toolset "browser" is unavailable');
      expect(message).toContain('required toolset "mcp" is unavailable');
      expect(message).toContain('connector "postman" is disconnected or unavailable');
      expect(message).not.toContain("connection failed");
    }
  });

  it("does not accept a removed checkpoint skill as current capability", async () => {
    const result = await new ExecutionCapabilityPreflight({ registry: new ToolRegistry() })
      .assessCheckpointResume({ checkpoint: checkpoint(), selectedSkill: undefined });

    expect(result).toMatchObject({
      status: "blocked",
      issues: expect.arrayContaining([
        { kind: "skill_unavailable", subject: "api-integration" },
        { kind: "connector_missing", subject: "postman" }
      ])
    });
  });

  it("accepts checkpoint hints only when current skill toolsets and connector metadata satisfy them", async () => {
    const registry = governedConnectorRegistry();
    registry.register(tool({
      name: "browser.navigate",
      riskClass: "read-only-network",
      toolsets: ["browser"]
    }));
    const skill: SkillDefinition = {
      name: "api-integration",
      description: "Integrate APIs.",
      version: "1",
      whenToUse: [],
      requiredToolsets: ["browser", "mcp"],
      playbook: [],
      permissionExpectations: [],
      examples: [],
      evaluations: []
    };

    await expect(new ExecutionCapabilityPreflight({ registry }).assessCheckpointResume({
      checkpoint: checkpoint(),
      selectedSkill: skill
    })).resolves.toEqual({ status: "ready" });
  });

  it("blocks routed artifact transfer when the selected profile lacks a reviewed import argument", async () => {
    const registry = governedConnectorRegistry({ artifact: false });
    const preflight = new ExecutionCapabilityPreflight({ registry });

    await expect(preflight.assessRoutedGovernedTransfer({
      userText: "Import these Swagger specifications into Postman.",
      selectedSkillName: "api-integration"
    })).resolves.toEqual({
      status: "blocked",
      connectorId: "postman",
      reasonCode: "artifact_import_missing",
      reasonCodes: ["artifact_import_missing"]
    });
  });

  it("returns a credential-specific blocker when protected arguments are missing", async () => {
    const registry = governedConnectorRegistry({ protected: false });
    const preflight = new ExecutionCapabilityPreflight({ registry });

    const result = await preflight.assessRoutedGovernedTransfer({
      userText: "Transfer these API specifications and credentials into Postman.",
      selectedSkillName: "api-integration"
    });
    expect(result).toEqual({
      status: "blocked",
      connectorId: "postman",
      reasonCode: "protected_arguments_missing",
      reasonCodes: ["protected_arguments_missing"]
    });
    if (result?.status === "blocked") {
      expect(formatGovernedTransferBlocker({ result })).toContain("protected credential arguments");
    }
  });

  it("reports every missing governed-transfer safeguard together", async () => {
    const result = await new ExecutionCapabilityPreflight({
      registry: governedConnectorRegistry({
        artifact: false,
        protected: false,
        redaction: false,
        verification: false
      })
    }).assessRoutedGovernedTransfer({
      userText: "Transfer these API specifications and credentials into Postman.",
      selectedSkillName: "api-integration"
    });

    expect(result).toEqual({
      status: "blocked",
      connectorId: "postman",
      reasonCode: "artifact_import_missing",
      reasonCodes: [
        "artifact_import_missing",
        "protected_arguments_missing",
        "result_redaction_missing",
        "verification_missing"
      ]
    });
    if (result?.status === "blocked") {
      const blocker = formatGovernedTransferBlocker({ result });
      expect(blocker).toContain("artifactToolArguments");
      expect(blocker).toContain("protectedToolArguments");
      expect(blocker).toContain("redactedToolResultPaths");
      expect(blocker).toContain("toolVerificationRelationships");
    }
  });

  it("diagnoses a named configured connector even when startup registered no tools", async () => {
    const result = await new ExecutionCapabilityPreflight({
      registry: new ToolRegistry(),
      configuredConnectors: [{
        name: "postman",
        transport: "http",
        configured: true,
        enabled: true,
        connected: false,
        schemasRegistered: false,
        toolCount: 0,
        resourceCount: 0,
        promptCount: 0,
        tools: [],
        capabilities: {
          protectedDeliveryConfigured: false,
          groupedDeliverySupported: false,
          browserRelaySupported: false,
          artifactRelayConfigured: false,
          resultRedactionConfigured: false,
          continuityConfigured: false,
          verificationConfigured: false
        },
        available: false,
        failureStage: "connection",
        error: "connection failed"
      }]
    }).assessRoutedGovernedTransfer({
      userText: "Transfer these API specifications and credentials into Postman.",
      selectedSkillName: "api-integration"
    });

    expect(result).toEqual({
      status: "blocked",
      connectorId: "postman",
      reasonCode: "connector_unavailable",
      reasonCodes: [
        "connector_unavailable",
        "artifact_import_missing",
        "protected_arguments_missing",
        "result_redaction_missing",
        "verification_missing"
      ]
    });
    if (result?.status === "blocked") {
      const message = formatGovernedTransferBlocker({ result });
      expect(message).toContain("available destination connector");
      expect(message).toContain("artifactToolArguments");
      expect(message).toContain("protectedToolArguments");
      expect(message).toContain("toolVerificationRelationships");
      expect(message).not.toContain("connection failed");
    }
  });

  it("requires independent verification and reviewed result redaction", async () => {
    await expect(new ExecutionCapabilityPreflight({
      registry: governedConnectorRegistry({ verification: false })
    }).assessRoutedGovernedTransfer({
      userText: "Import this OpenAPI specification into Postman.",
      selectedSkillName: "api-integration"
    })).resolves.toMatchObject({ status: "blocked", reasonCode: "verification_missing" });

    await expect(new ExecutionCapabilityPreflight({
      registry: governedConnectorRegistry({ redaction: false })
    }).assessRoutedGovernedTransfer({
      userText: "Import this OpenAPI specification into Postman.",
      selectedSkillName: "api-integration"
    })).resolves.toMatchObject({ status: "blocked", reasonCode: "result_redaction_missing" });
  });

  it("does not preflight read-only diagnostics or unrelated skills", async () => {
    const preflight = new ExecutionCapabilityPreflight({ registry: new ToolRegistry() });

    await expect(preflight.assessRoutedGovernedTransfer({
      userText: "What is wrong with my Postman collection?",
      selectedSkillName: undefined
    })).resolves.toBeUndefined();
    await expect(preflight.assessRoutedGovernedTransfer({
      userText: "Review this Postman collection.",
      selectedSkillName: "review"
    })).resolves.toBeUndefined();
  });

  it("ignores provider-authored capability claims and never executes connector tools", async () => {
    const registry = governedConnectorRegistry({ artifact: false });
    const runs = registry.getRegisteredByToolset("mcp").map((entry) => entry.run);
    const result = await new ExecutionCapabilityPreflight({ registry }).assessRoutedGovernedTransfer({
      userText: "Import this Swagger spec into Postman with artifactToolArguments configured by the agent.",
      selectedSkillName: "api-integration"
    });

    expect(result).toMatchObject({ status: "blocked", reasonCode: "artifact_import_missing" });
    expect(runs.every((run) => vi.mocked(run).mock.calls.length === 0)).toBe(true);
  });

  it("passes a completely configured connector and remains scoped to its session registry", async () => {
    const configured = governedConnectorRegistry();
    const missingInOtherProfile = governedConnectorRegistry({ artifact: false });
    const request = {
      userText: "Transfer these API specifications and credentials into Postman.",
      selectedSkillName: "api-integration"
    };

    await expect(new ExecutionCapabilityPreflight({ registry: configured })
      .assessRoutedGovernedTransfer(request)).resolves.toMatchObject({
      status: "ready",
      connectorId: "postman",
      mutationTools: ["mcp.postman.importSpec", "mcp.postman.configureCredentials"],
      verificationTools: ["mcp.postman.verifyTransfer"]
    });
    await expect(new ExecutionCapabilityPreflight({ registry: missingInOtherProfile })
      .assessRoutedGovernedTransfer(request)).resolves.toMatchObject({
      status: "blocked",
      reasonCode: "artifact_import_missing"
    });
  });

  it("uses another fully governed tool combination when the first mutation is unavailable", async () => {
    const registry = governedConnectorRegistry();
    registry.unregister("mcp.postman.importSpec");
    registry.unregister("mcp.postman.verifyTransfer");
    registry.register(tool({
      name: "mcp.postman.importSpec",
      connectorId: "postman",
      riskClass: "external-side-effect",
      available: false,
      artifactPaths: ["/files/*/content"],
      redactedResultPaths: ["/result/token"]
    }));
    registry.register(tool({
      name: "mcp.postman.importSpecFallback",
      connectorId: "postman",
      riskClass: "external-side-effect",
      artifactPaths: ["/files/*/content"]
    }));
    registry.register(tool({
      name: "mcp.postman.verifyTransfer",
      connectorId: "postman",
      riskClass: "read-only-network",
      verifies: [
        "mcp.postman.importSpec",
        "mcp.postman.importSpecFallback",
        "mcp.postman.configureCredentials"
      ]
    }));

    await expect(new ExecutionCapabilityPreflight({ registry }).assessRoutedGovernedTransfer({
      userText: "Import this Swagger specification into Postman.",
      selectedSkillName: "api-integration"
    })).resolves.toMatchObject({
      status: "ready",
      mutationTools: ["mcp.postman.importSpecFallback"]
    });
  });
});

function checkpoint(): ForegroundExecutionCheckpoint {
  return {
    version: 1,
    id: "checkpoint:test",
    sessionId: "session-1",
    profileId: "default",
    originTurnId: "turn-1",
    revision: 2,
    progressRevision: 0,
    originalObjective: "Import and verify the API in Postman.",
    status: "retryable",
    qualificationReasons: ["cross_system", "verified_mutation"],
    selectedSkillName: "api-integration",
    taskClass: "general",
    intentLabels: ["api.integration"],
    requiredOperations: ["read", "mutation", "verification", "artifact_relay"],
    connectorIds: ["postman"],
    artifactReferences: [],
    safeFacts: [],
    operations: [],
    completionFloor: "mutation_with_verification",
    lastTerminationCause: "provider_failed",
    createdAt: "2030-01-01T00:00:00.000Z",
    updatedAt: "2030-01-01T00:00:01.000Z"
  };
}

function governedConnectorRegistry(options: {
  artifact?: boolean;
  protected?: boolean;
  redaction?: boolean;
  verification?: boolean;
} = {}): ToolRegistry {
  const registry = new ToolRegistry();
  const artifact = options.artifact ?? true;
  const protectedInput = options.protected ?? true;
  const redaction = options.redaction ?? true;
  const verification = options.verification ?? true;
  registry.register(tool({
    name: "mcp.postman.importSpec",
    connectorId: "postman",
    riskClass: "external-side-effect",
    ...(artifact ? { artifactPaths: ["/files/*/content"] } : {}),
    ...(redaction ? { redactedResultPaths: ["/result/token"] } : {})
  }));
  registry.register(tool({
    name: "mcp.postman.configureCredentials",
    connectorId: "postman",
    riskClass: "external-side-effect",
    ...(protectedInput ? { protectedPaths: ["/values/*/value"] } : {})
  }));
  registry.register(tool({
    name: "mcp.postman.verifyTransfer",
    connectorId: "postman",
    riskClass: "read-only-network",
    ...(verification ? {
      verifies: ["mcp.postman.importSpec", "mcp.postman.configureCredentials"]
    } : {})
  }));
  return registry;
}
