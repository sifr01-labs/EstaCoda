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
