import { describe, expect, it } from "vitest";
import { validateRequestRequirements } from "./request-requirements.js";

describe("persisted copy requirements", () => {
  it.each([{}, { sourcePath: "source file.md" }])("round-trips a bounded copy requirement %#", exactCopy => {
    const requirements = { skillReferences: [], issues: [], fileOutput: { format: "markdown", path: "copy.md", exactCopy } };
    expect(validateRequestRequirements(JSON.parse(JSON.stringify(requirements)))).toEqual(requirements);
  });
  it.each([{ sourcePath: "../outside.md" }, { sourcePath: "/tmp/source.md" }, { sourcePath: "" }, { sourcePath: 42 }, { sourcePath: "a.md", authorized: true }, []])("rejects malformed or unsafe copy state %#", exactCopy => {
    expect(() => validateRequestRequirements({ skillReferences: [], issues: [], fileOutput: { format: "text", path: "copy.txt", exactCopy } })).toThrow();
  });
});

describe("persisted multiple file requirements", () => {
  const primary = { format: "markdown", path: "report.md" };
  const secondary = { format: "text", path: "data.json", exactCopy: { sourcePath: "source.json" } };
  it("round-trips separate formats and copy constraints", () => {
    const requirements = { skillReferences: [], issues: [], fileOutput: { ...primary, additionalFiles: [secondary] } };
    expect(validateRequestRequirements(JSON.parse(JSON.stringify(requirements)))).toEqual(requirements);
  });
  it.each([
    [], [primary], [{ ...primary, path: "./report.md" }], [{ format: "text" }],
    [{ ...secondary, path: "../outside.json" }], [{ ...secondary, path: "/outside.json" }],
    [{ ...secondary, exactCopy: { sourcePath: "../source.json" } }],
    [{ ...secondary, additionalFiles: [primary] }], [{ ...secondary, authorized: true }],
    Array.from({ length: 8 }, (_, i) => ({ format: "text", path: `file-${i}.txt` }))
  ])("rejects malformed, duplicate, unsafe or excessive additional files %#", (...additionalFiles) => {
    expect(() => validateRequestRequirements({ skillReferences: [], issues: [], fileOutput: { ...primary, additionalFiles } })).toThrow();
  });
  it("requires a named primary when additional files exist", () => {
    expect(() => validateRequestRequirements({ skillReferences: [], issues: [], fileOutput: { format: "text", additionalFiles: [secondary] } })).toThrow();
  });
});


describe("explicit alternative destinations", () => {
  it.each([[], ["a.txt"], ["./a.txt"], ["../escape.txt"], ["/outside.txt"], [undefined], [2], Array.from({ length: 8 }, (_, i) => `b${i}.txt`)])("rejects invalid alternatives %#", (...alternativePaths) => {
    expect(() => validateRequestRequirements({ skillReferences: [], issues: [], fileOutput: { format: "text", path: "a.txt", alternativePaths } })).toThrow();
  });
  it("counts alternatives together with mandatory outputs", () => {
    expect(() => validateRequestRequirements({ skillReferences: [], issues: [], fileOutput: { format: "text", path: "a.txt", alternativePaths: ["b.txt"], additionalFiles: [{ format: "text", path: "b.txt" }] } })).toThrow();
  });
});


describe("unspecified directory state", () => {
  it("round trips a bare filename constraint", () => {
    const value = { skillReferences: [], issues: [], fileOutput: { format: "text", path: "extract.js", directoryUnspecified: true } };
    expect(validateRequestRequirements(value)).toEqual(value);
  });
  it.each([
    { path: "app/extract.js" }, { path: "../extract.js" }, { path: "/extract.js" }, { path: "extract.js", directoryUnspecified: false },
    { path: "extract.js", alternativePaths: ["app/other.js"] }, { path: "extract.js", exactCopy: {} }, { path: undefined }
  ])("rejects invalid broadening %#", file => {
    expect(() => validateRequestRequirements({ skillReferences: [], issues: [], fileOutput: { format: "text", directoryUnspecified: true, ...file } })).toThrow();
  });
});

it("round trips execution policy while preserving legacy and report/copy content checks", async () => {
  const { requiresAnyFileContentVerification } = await import("./request-requirements.js");
  const ordinary = validateRequestRequirements({ skillReferences: [], issues: [], fileOutput: { format: "artifact", path: "model.pt", verification: "execution" } });
  expect(validateRequestRequirements(JSON.parse(JSON.stringify(ordinary)))).toEqual(ordinary);
  expect(requiresAnyFileContentVerification(ordinary)).toBe(false);
  expect(requiresAnyFileContentVerification({ ...ordinary, fileOutput: { ...ordinary.fileOutput!, verification: undefined } })).toBe(true);
  expect(requiresAnyFileContentVerification({ ...ordinary, sourceTaskId: "accepted-task" })).toBe(true);
  expect(requiresAnyFileContentVerification({ ...ordinary, research: { domain: "general", fresh: false } })).toBe(true);
  expect(requiresAnyFileContentVerification({ ...ordinary, fileOutput: { ...ordinary.fileOutput!, exactCopy: { sourcePath: "source.pt" } } })).toBe(true);
  expect(() => validateRequestRequirements({ ...ordinary, fileOutput: { ...ordinary.fileOutput!, verification: "skip" } })).toThrow();
});
