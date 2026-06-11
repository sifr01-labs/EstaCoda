import { describe, expect, it } from "vitest";
import { FileStateTracker } from "./file-state-tracker.js";
import { findStaleParentFileReadWarnings } from "./file-state-guard.js";

describe("findStaleParentFileReadWarnings", () => {
  it("warns when a child writes a file the parent read before delegation started", () => {
    const tracker = new FileStateTracker();
    tracker.recordOperation({
      sessionId: "parent",
      path: "src/../src/app.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z",
      metadata: { bytes: 15 }
    });
    const snapshot = tracker.snapshotReads("parent", "2026-06-11T10:01:00.000Z");
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "./src/app.ts",
      operation: "write",
      sourceTool: "file.write",
      timestamp: "2026-06-11T10:02:00.000Z",
      metadata: {
        bytes: 20,
        changed: true,
        previewAvailable: true
      }
    });

    expect(findStaleParentFileReadWarnings({
      tracker,
      parentReadSnapshot: snapshot,
      parentSessionId: "parent",
      childSessionId: "child",
      taskIndex: 0,
      batchId: "batch-1"
    })).toEqual([
      {
        kind: "stale-parent-file-read",
        normalizedPath: "src/app.ts",
        displayPath: "./src/app.ts",
        parentSessionId: "parent",
        childSessionId: "child",
        parentReadAt: "2026-06-11T10:00:00.000Z",
        childWriteAt: "2026-06-11T10:02:00.000Z",
        writeOperation: "write",
        sourceTool: "file.write",
        taskIndex: 0,
        batchId: "batch-1"
      }
    ]);
  });

  it("includes replace and notebook delete operations when they match a parent read", () => {
    const tracker = new FileStateTracker();
    tracker.recordOperation({
      sessionId: "parent",
      path: "analysis.ipynb",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z"
    });
    const snapshot = tracker.snapshotReads("parent", "2026-06-11T10:01:00.000Z");
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "analysis.ipynb",
      operation: "replace",
      sourceTool: "notebook.edit",
      timestamp: "2026-06-11T10:02:00.000Z"
    });
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "analysis.ipynb",
      operation: "delete",
      sourceTool: "notebook.edit",
      timestamp: "2026-06-11T10:03:00.000Z"
    });

    expect(findStaleParentFileReadWarnings({
      tracker,
      parentReadSnapshot: snapshot,
      parentSessionId: "parent",
      childSessionId: "child"
    }).map((warning) => warning.writeOperation)).toEqual(["replace", "delete"]);
  });

  it("warns when a child write happens after the snapshot with the same millisecond timestamp", () => {
    const tracker = new FileStateTracker();
    tracker.recordOperation({
      sessionId: "parent",
      path: "src/app.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z"
    });
    const snapshot = tracker.snapshotReads("parent", "2026-06-11T10:00:00.000Z");
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "src/app.ts",
      operation: "write",
      sourceTool: "file.write",
      timestamp: "2026-06-11T10:00:00.000Z"
    });

    expect(findStaleParentFileReadWarnings({
      tracker,
      parentReadSnapshot: snapshot,
      parentSessionId: "parent",
      childSessionId: "child"
    })).toEqual([
      expect.objectContaining({
        normalizedPath: "src/app.ts",
        parentReadAt: "2026-06-11T10:00:00.000Z",
        childWriteAt: "2026-06-11T10:00:00.000Z",
        writeOperation: "write"
      })
    ]);
  });

  it("does not warn for unrelated paths or writes before delegation start", () => {
    const tracker = new FileStateTracker();
    tracker.recordOperation({
      sessionId: "parent",
      path: "src/app.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z"
    });
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "src/app.ts",
      operation: "write",
      sourceTool: "file.write",
      timestamp: "2026-06-11T10:00:30.000Z"
    });
    const snapshot = tracker.snapshotReads("parent", "2026-06-11T10:01:00.000Z");
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "src/other.ts",
      operation: "write",
      sourceTool: "file.write",
      timestamp: "2026-06-11T10:02:00.000Z"
    });

    expect(findStaleParentFileReadWarnings({
      tracker,
      parentReadSnapshot: snapshot,
      parentSessionId: "parent",
      childSessionId: "child"
    })).toEqual([]);
  });

  it("does not warn for parent reads after the pre-delegation snapshot", () => {
    const tracker = new FileStateTracker();
    const snapshot = tracker.snapshotReads("parent", "2026-06-11T10:01:00.000Z");
    tracker.recordOperation({
      sessionId: "parent",
      path: "src/app.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:02:00.000Z"
    });
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "src/app.ts",
      operation: "write",
      sourceTool: "file.write",
      timestamp: "2026-06-11T10:03:00.000Z"
    });

    expect(findStaleParentFileReadWarnings({
      tracker,
      parentReadSnapshot: snapshot,
      parentSessionId: "parent",
      childSessionId: "child"
    })).toEqual([]);
  });

  it("does not include file contents, previews, diffs, prompts, child output, secrets, or tool arguments", () => {
    const tracker = new FileStateTracker();
    tracker.recordOperation({
      sessionId: "parent",
      path: "secrets.txt",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z",
      metadata: { bytes: 11 }
    });
    const snapshot = tracker.snapshotReads("parent", "2026-06-11T10:01:00.000Z");
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "secrets.txt",
      operation: "replace",
      sourceTool: "file.replace",
      timestamp: "2026-06-11T10:02:00.000Z",
      metadata: {
        bytes: 22,
        changed: true,
        previewAvailable: true,
        oldText: "OPENAI_API_KEY=sk-secret",
        newText: "raw child output"
      } as never
    });

    const warningText = JSON.stringify(findStaleParentFileReadWarnings({
      tracker,
      parentReadSnapshot: snapshot,
      parentSessionId: "parent",
      childSessionId: "child"
    }));

    expect(warningText).toContain("secrets.txt");
    expect(warningText).not.toContain("OPENAI_API_KEY");
    expect(warningText).not.toContain("sk-secret");
    expect(warningText).not.toContain("raw child output");
    expect(warningText).not.toContain("oldText");
    expect(warningText).not.toContain("newText");
    expect(warningText).not.toContain("previewAvailable");
  });

  it("returns no warnings without tracker data or child session id", () => {
    const tracker = new FileStateTracker();
    const snapshot = tracker.snapshotReads("parent", "2026-06-11T10:01:00.000Z");

    expect(findStaleParentFileReadWarnings({
      parentReadSnapshot: snapshot,
      parentSessionId: "parent",
      childSessionId: "child"
    })).toEqual([]);
    expect(findStaleParentFileReadWarnings({
      tracker,
      parentReadSnapshot: snapshot,
      parentSessionId: "parent"
    })).toEqual([]);
  });
});
