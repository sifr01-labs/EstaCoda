import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { homedir } from "node:os";
import { resolveHomeDir, resolveOsHomeDir } from "./home-dir.js";

describe("resolveHomeDir", () => {
  const originalHome = process.env.HOME;
  const originalEstacodaHome = process.env.ESTACODA_HOME;

  beforeEach(() => {
    process.env.HOME = "/tmp/prod-home";
    process.env.ESTACODA_HOME = "/tmp/dev-home";
  });

  afterEach(() => {
    restoreEnv("HOME", originalHome);
    restoreEnv("ESTACODA_HOME", originalEstacodaHome);
  });

  it("uses an explicit value before ESTACODA_HOME and HOME", () => {
    expect(resolveHomeDir("/tmp/explicit-home")).toBe("/tmp/explicit-home");
  });

  it("uses ESTACODA_HOME before HOME", () => {
    expect(resolveHomeDir()).toBe("/tmp/dev-home");
  });

  it("uses HOME when ESTACODA_HOME is absent", () => {
    delete process.env.ESTACODA_HOME;

    expect(resolveHomeDir()).toBe("/tmp/prod-home");
  });

  it("uses os.homedir() when no explicit or env value exists", () => {
    delete process.env.ESTACODA_HOME;
    delete process.env.HOME;

    expect(resolveHomeDir()).toBe(homedir());
  });
});

describe("resolveOsHomeDir", () => {
  it("uses HOME first", () => {
    expect(resolveOsHomeDir({
      HOME: "/tmp/os-home",
      USERPROFILE: "/tmp/user-profile",
      ESTACODA_HOME: "/tmp/dev-home",
    })).toBe("/tmp/os-home");
  });

  it("uses USERPROFILE when HOME is absent", () => {
    expect(resolveOsHomeDir({
      USERPROFILE: "/tmp/user-profile",
      ESTACODA_HOME: "/tmp/dev-home",
    })).toBe("/tmp/user-profile");
  });

  it("uses os.homedir() when HOME and USERPROFILE are absent", () => {
    expect(resolveOsHomeDir({
      ESTACODA_HOME: "/tmp/dev-home",
    })).toBe(homedir());
  });

  it("ignores ESTACODA_HOME", () => {
    expect(resolveOsHomeDir({
      HOME: "/tmp/os-home",
      ESTACODA_HOME: "/tmp/dev-home",
    })).toBe("/tmp/os-home");
  });
});

function restoreEnv(key: "HOME" | "ESTACODA_HOME", value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
    return;
  }
  process.env[key] = value;
}
