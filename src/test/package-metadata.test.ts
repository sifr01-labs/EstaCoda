import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

type PackageJson = {
  name?: string;
  private?: boolean;
  type?: string;
  bin?: Record<string, string>;
  engines?: Record<string, string>;
  files?: string[];
};

describe("package installability metadata", () => {
  it("declares the estacoda binary and prelaunch publish guard", async () => {
    const raw = await readFile(resolve(process.cwd(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as PackageJson;

    expect(pkg.name).toBe("estacoda");
    expect(pkg.private).toBe(true);
    expect(pkg.type).toBe("module");
    expect(pkg.bin?.estacoda).toBe("./dist/index.js");
    expect(pkg.engines?.node).toBeDefined();
  });

  it("includes runtime-required package roots", async () => {
    const raw = await readFile(resolve(process.cwd(), "package.json"), "utf8");
    const pkg = JSON.parse(raw) as PackageJson;

    expect(pkg.files).toEqual(expect.arrayContaining([
      "dist",
      "skills",
      "assets",
      "workers",
      "acp_registry",
      "scripts/install.sh",
      "scripts/estacoda-wrapper.sh",
      "README.md",
      "LICENSE",
      "NOTICE",
      "CHANGELOG.md",
      "package.json"
    ]));
  });
});
