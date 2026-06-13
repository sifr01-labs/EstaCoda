import { describe, it, expect, afterEach } from "vitest";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSkillsFromDirectory } from "./skill-loader.js";
import {
  registerPythonCapabilitySpecForTest,
  resetPythonCapabilityRegistryForTest
} from "../python-env/capability-registry.js";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "estacoda-skill-loader-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(async () => {
  resetPythonCapabilityRegistryForTest();
  while (tempDirs.length > 0) {
    await rm(tempDirs.pop()!, { recursive: true, force: true });
  }
});

describe("loadSkillsFromDirectory", () => {
  it("returns empty skills and errors when the directory does not exist", async () => {
    const missingDir = join(tmpdir(), "estacoda-skill-loader-does-not-exist-" + Date.now());
    const result = await loadSkillsFromDirectory(missingDir, {
      sourceKind: "external",
      sourceRoot: missingDir
    });
    expect(result.skills).toHaveLength(0);
    expect(result.errors).toHaveLength(0);
  });

  it("returns errors for malformed SKILL.md files in an existing directory", async () => {
    const root = await makeTempDir();
    const skillDir = join(root, "bad-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"), "not valid frontmatter", "utf8");

    const result = await loadSkillsFromDirectory(root, {
      sourceKind: "local",
      sourceRoot: root
    });
    expect(result.skills).toHaveLength(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].message).toContain("frontmatter");
  });

  it("loads a valid SKILL.md from an existing directory", async () => {
    const root = await makeTempDir();
    const skillDir = join(root, "valid-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      "---\nname: valid-skill\ndescription: A valid test skill\nversion: 1.0.0\ncategory: test\n---\nDo the thing.\n",
      "utf8"
    );

    const result = await loadSkillsFromDirectory(root, {
      sourceKind: "local",
      sourceRoot: root
    });
    expect(result.errors).toHaveLength(0);
    expect(result.skills).toHaveLength(1);
    expect(result.skills[0].name).toBe("valid-skill");
  });

  it("loads playbook frontmatter", async () => {
    const root = await makeTempDir();
    const skillDir = join(root, "playbook-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        JSON.stringify({
          name: "playbook-skill",
          description: "A valid playbook skill",
          version: "1.0.0",
          category: "test",
          playbook: [{ id: "read", description: "Read the input" }]
        }),
        "---",
        "Do the thing."
      ].join("\n"),
      "utf8"
    );

    const result = await loadSkillsFromDirectory(root, {
      sourceKind: "local",
      sourceRoot: root
    });
    expect(result.errors).toHaveLength(0);
    expect(result.skills[0].playbook[0]?.id).toBe("read");
  });

  it("rejects legacy workflow frontmatter", async () => {
    const root = await makeTempDir();
    const skillDir = join(root, "workflow-skill");
    const legacyWorkflowField = "work" + "flow";
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        JSON.stringify({
          name: "workflow-skill",
          description: "A legacy workflow skill",
          version: "1.0.0",
          category: "test",
          [legacyWorkflowField]: [{ id: "read", description: "Read the input" }]
        }),
        "---",
        "Do the thing."
      ].join("\n"),
      "utf8"
    );

    const result = await loadSkillsFromDirectory(root, {
      sourceKind: "local",
      sourceRoot: root
    });
    expect(result.skills).toHaveLength(0);
    expect(result.errors[0].message).toContain("workflow has been renamed to playbook");
  });

  it("loads valid pythonCapabilities metadata with required and optional declarations", async () => {
    registerFakePythonCapability();
    const root = await makeTempDir();
    const skillDir = join(root, "python-capability-skill");
    await mkdir(skillDir, { recursive: true });
    await writeFile(
      join(skillDir, "SKILL.md"),
      [
        "---",
        "name: python-capability-skill",
        "description: A skill with Python capability metadata",
        "version: 1.0.0",
        "pythonCapabilities:",
        "  - id: fake-skill-python",
        "    required: true",
        "    groups: [extra, extra]",
        "  - id: fake-optional-python",
        "    required: false",
        "    groups: []",
        "---",
        "Do the thing."
      ].join("\n"),
      "utf8"
    );

    const result = await loadSkillsFromDirectory(root, {
      sourceKind: "local",
      sourceRoot: root
    });

    expect(result.errors).toHaveLength(0);
    expect(result.skills[0].pythonCapabilities).toEqual([
      { id: "fake-optional-python", required: false, groups: [] },
      { id: "fake-skill-python", required: true, groups: ["extra"] }
    ]);
  });

  it("preserves required base and optional group declarations for the same Python capability", async () => {
    registerFakePythonCapability();

    const result = await loadSkillWithPythonCapabilities([
      { id: "fake-skill-python", required: true, groups: [] },
      { id: "fake-skill-python", required: false, groups: ["extra", "extra"] }
    ]);

    expect(result.errors).toHaveLength(0);
    expect(result.skills[0].pythonCapabilities).toEqual([
      { id: "fake-skill-python", required: true, groups: [] },
      { id: "fake-skill-python", required: false, groups: ["extra"] }
    ]);
  });

  it("deduplicates exact Python capability declarations and rejects conflicting required values", async () => {
    registerFakePythonCapability();

    const duplicate = await loadSkillWithPythonCapabilities([
      { id: "fake-skill-python", required: false, groups: ["extra"] },
      { id: "fake-skill-python", required: false, groups: ["extra", "extra"] }
    ]);
    expect(duplicate.errors).toHaveLength(0);
    expect(duplicate.skills[0].pythonCapabilities).toEqual([
      { id: "fake-skill-python", required: false, groups: ["extra"] }
    ]);

    const conflicting = await loadSkillWithPythonCapabilities([
      { id: "fake-skill-python", required: true, groups: ["extra"] },
      { id: "fake-skill-python", required: false, groups: ["extra"] }
    ]);
    expect(conflicting.skills).toHaveLength(0);
    expect(conflicting.errors[0].message).toContain("conflicts with another declaration");
  });

  it("rejects unknown Python capability ids and optional groups", async () => {
    registerFakePythonCapability();
    const unknownId = await loadSkillWithPythonCapabilities([
      { id: "missing-capability", required: true, groups: [] }
    ]);
    expect(unknownId.skills).toHaveLength(0);
    expect(unknownId.errors[0].message).toContain("unknown managed Python capability");

    const unknownGroup = await loadSkillWithPythonCapabilities([
      { id: "fake-skill-python", required: true, groups: ["missing-group"] }
    ]);
    expect(unknownGroup.skills).toHaveLength(0);
    expect(unknownGroup.errors[0].message).toContain("unknown optional group");
  });

  it("rejects malformed or package-owning pythonCapabilities metadata", async () => {
    registerFakePythonCapability();
    const malformed = await loadSkillWithFrontmatter({
      name: "malformed-python-capability-skill",
      description: "Malformed Python capability metadata",
      pythonCapabilities: "fake-skill-python"
    });
    expect(malformed.skills).toHaveLength(0);
    expect(malformed.errors[0].message).toContain("pythonCapabilities must be an array");

    const malformedGroups = await loadSkillWithPythonCapabilities([
      { id: "fake-skill-python", required: true, groups: [123] }
    ]);
    expect(malformedGroups.skills).toHaveLength(0);
    expect(malformedGroups.errors[0].message).toContain("groups[0] must be a non-empty string");

    const packageOwning = await loadSkillWithPythonCapabilities([
      {
        id: "fake-skill-python",
        required: true,
        groups: [],
        packages: ["demo==1.0.0"]
      }
    ]);
    expect(packageOwning.skills).toHaveLength(0);
    expect(packageOwning.errors[0].message).toContain("must not define unsupported field 'packages'");
  });

  it.each([
    {
      field: "requirements",
      unsupportedField: "requirements",
      lines: ["    requirements:", "      - httpx"]
    },
    {
      field: "installCommand",
      unsupportedField: "installCommand",
      lines: ["    installCommand: \"pip install httpx\""]
    },
    {
      field: "verify_imports",
      unsupportedField: "verifyImports",
      lines: ["    verify_imports:", "      - httpx"]
    },
    {
      field: "verifyImports",
      unsupportedField: "verifyImports",
      lines: ["    verifyImports:", "      - httpx"]
    },
    {
      field: "python_path",
      unsupportedField: "pythonPath",
      lines: ["    python_path: \"/tmp/python\""]
    },
    {
      field: "pythonPath",
      unsupportedField: "pythonPath",
      lines: ["    pythonPath: \"/tmp/python\""]
    },
    {
      field: "version",
      unsupportedField: "version",
      lines: ["    version: \"3.12\""]
    },
    {
      field: "futureRuntimeOwnedField",
      unsupportedField: "futureRuntimeOwnedField",
      lines: ["    futureRuntimeOwnedField: true"]
    }
  ])("rejects pythonCapabilities entries with unsupported field $field", async ({ unsupportedField, lines }) => {
    registerMockBasicPythonCapability();

    const result = await loadSkillWithPythonCapabilityYaml(lines);

    expect(result.skills).toHaveLength(0);
    expect(result.errors[0].message).toContain(`must not define unsupported field '${unsupportedField}'`);
  });
});

function registerFakePythonCapability(): void {
  registerPythonCapabilitySpecForTest({
    id: "fake-skill-python",
    version: "0.1.0",
    packages: ["demo-package==1.2.3"],
    verifyImports: ["json"],
    optionalGroups: {
      extra: {
        packages: ["demo-extra==2.0.0"],
        verifyImports: ["email"]
      }
    }
  });
  registerPythonCapabilitySpecForTest({
    id: "fake-optional-python",
    version: "0.1.0",
    packages: [],
    verifyImports: ["json"]
  });
}

function registerMockBasicPythonCapability(): void {
  registerPythonCapabilitySpecForTest({
    id: "mock-basic",
    version: "0.1.0",
    packages: [],
    verifyImports: ["json"]
  });
}

async function loadSkillWithPythonCapabilities(pythonCapabilities: unknown[]) {
  return loadSkillWithFrontmatter({
    name: "python-capability-test-skill",
    description: "A Python capability test skill",
    pythonCapabilities
  });
}

async function loadSkillWithFrontmatter(frontmatter: Record<string, unknown>) {
  const root = await makeTempDir();
  const skillDir = join(root, String(frontmatter.name ?? "skill"));
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    ["---", JSON.stringify(frontmatter), "---", "Do the thing."].join("\n"),
    "utf8"
  );
  return await loadSkillsFromDirectory(root, {
    sourceKind: "local",
    sourceRoot: root
  });
}

async function loadSkillWithPythonCapabilityYaml(extraCapabilityLines: string[]) {
  const root = await makeTempDir();
  const skillDir = join(root, "mock-basic-python-capability-skill");
  await mkdir(skillDir, { recursive: true });
  await writeFile(
    join(skillDir, "SKILL.md"),
    [
      "---",
      "name: mock-basic-python-capability-skill",
      "description: A Python capability whitelist test skill",
      "version: 1.0.0",
      "pythonCapabilities:",
      "  - id: mock-basic",
      "    required: true",
      "    groups: []",
      ...extraCapabilityLines,
      "---",
      "Do the thing."
    ].join("\n"),
    "utf8"
  );
  return await loadSkillsFromDirectory(root, {
    sourceKind: "local",
    sourceRoot: root
  });
}
