import { describe, expect, it, vi } from "vitest";
import type { BrowserFieldSecureInputSource } from "../contracts/secure-input.js";
import {
  ProtectedBrowserSourceController,
  type ProtectedBrowserSourceSession,
} from "./protected-browser-source.js";

const source: BrowserFieldSecureInputSource = {
  type: "browser-field",
  sessionId: "session-1",
  ref: "@e1",
  identity: { documentEpoch: 2, actionRevision: 3, observationId: 4 },
  expectedOrigin: "https://portal.example.com",
  tabRef: "@t1",
  frameId: "main-frame",
};

describe("ProtectedBrowserSourceController", () => {
  it("binds an exact current element, detects no change, reads bytes, and releases object handles", async () => {
    const harness = sourceSession("source-sentinel");
    const controller = new ProtectedBrowserSourceController();

    await expect(controller.verify(harness.session, {
      source,
      kind: "client-secret",
      phase: "before-authorization",
    })).resolves.toEqual({
      status: "verified",
      sourceLabel: "Browser value at https://portal.example.com",
    });
    await expect(controller.verify(harness.session, {
      source,
      kind: "client-secret",
      phase: "before-delivery",
    })).resolves.toMatchObject({ status: "verified" });
    const read = await controller.read(harness.session, { source, kind: "client-secret" });

    expect(read.status).toBe("read");
    if (read.status !== "read") throw new Error("Expected a protected source value.");
    expect(new TextDecoder().decode(read.value)).toBe("source-sentinel");
    read.value.fill(0);
    await controller.release(source);
    expect(harness.release).toHaveBeenCalledWith("source-object");
    expect(harness.release).toHaveBeenCalledWith("document-object");
  });

  it("fails closed when the bound browser value changes after authorization", async () => {
    const harness = sourceSession("first-value");
    const controller = new ProtectedBrowserSourceController();
    await controller.verify(harness.session, {
      source,
      kind: "api-key",
      phase: "before-authorization",
    });
    harness.setValue("changed-value");

    await expect(controller.verify(harness.session, {
      source,
      kind: "api-key",
      phase: "before-delivery",
    })).resolves.toEqual({ status: "rejected", reason: "source-replaced" });
    await expect(controller.read(harness.session, { source, kind: "api-key" }))
      .resolves.toEqual({ status: "rejected", reason: "source-replaced" });
    await controller.release(source);
  });

  it("rejects a source after its origin changes", async () => {
    const harness = sourceSession("source-sentinel");
    harness.setUrl("https://attacker.example/path");
    const controller = new ProtectedBrowserSourceController();

    await expect(controller.verify(harness.session, {
      source,
      kind: "client-secret",
      phase: "before-authorization",
    })).resolves.toEqual({ status: "rejected", reason: "origin-mismatch" });
  });
});

function sourceSession(initialValue: string): {
  session: ProtectedBrowserSourceSession;
  release: ReturnType<typeof vi.fn>;
  setValue(value: string): void;
  setUrl(value: string): void;
} {
  let value = initialValue;
  let url = "https://portal.example.com/credentials";
  const release = vi.fn();
  const supervisor = {
    getSnapshot: vi.fn(async () => ({ url })),
    send: vi.fn(async (method: string, params?: Record<string, unknown>) => {
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main-frame" } } };
      if (method === "Runtime.evaluate") {
        return String(params?.expression).includes("document")
          ? { result: { objectId: "document-object" } }
          : { result: { objectId: "source-object" } };
      }
      if (method === "Runtime.releaseObject") {
        release(params?.objectId);
        return {};
      }
      if (method === "Runtime.callFunctionOn" && params?.objectId === "document-object") {
        return { result: { value: true } };
      }
      if (method === "Runtime.callFunctionOn" && params?.objectId === "source-object") {
        const includeValue = (params.arguments as Array<{ value: unknown }> | undefined)?.[1]?.value === true;
        return {
          result: {
            value: {
              connected: true,
              current: true,
              visible: true,
              empty: value.length === 0,
              fingerprint: fingerprint(value),
              ...(includeValue ? { value } : {}),
            },
          },
        };
      }
      throw new Error(`Unexpected CDP call ${method}`);
    }),
  };
  return {
    session: { key: "session-1", tabRef: "@t1", supervisor },
    release,
    setValue(next) { value = next; },
    setUrl(next) { url = next; },
  };
}

function fingerprint(value: string): string {
  return `fingerprint:${value}`;
}
