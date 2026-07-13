import { describe, expect, it } from "vitest";
import { FileStateTracker } from "./file-state-tracker.js";

describe("FileStateTracker", () => {
  it("records operations with normalized paths and bounded metadata only", () => {
    const tracker = new FileStateTracker();

    const operation = tracker.recordOperation({
      sessionId: "session-1",
      path: "src/../src/app.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z",
      metadata: {
        bytes: 12.7,
        changed: true,
        previewAvailable: false,
        content: "secret file contents"
      } as never
    });

    expect(operation).toMatchObject({
      sequence: 1,
      sessionId: "session-1",
      path: "src/../src/app.ts",
      normalizedPath: "src/app.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z",
      metadata: {
        bytes: 12,
        changed: true,
        previewAvailable: false
      }
    });
    expect(JSON.stringify(operation)).not.toContain("secret file contents");
  });

  it("snapshots reads for a session", () => {
    const tracker = new FileStateTracker();
    tracker.recordOperation({
      sessionId: "parent",
      path: "a.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z"
    });
    tracker.recordOperation({
      sessionId: "child",
      path: "a.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:01:00.000Z"
    });

    const snapshot = tracker.snapshotReads("parent", "2026-06-11T10:02:00.000Z");

    expect(snapshot).toMatchObject({
      sessionId: "parent",
      capturedAt: "2026-06-11T10:02:00.000Z",
      capturedSequence: 2,
      reads: [
        expect.objectContaining({
          sessionId: "parent",
          normalizedPath: "a.ts"
        })
      ]
    });
  });

  it("assigns monotonic operation sequences and snapshots the current cursor", () => {
    const tracker = new FileStateTracker();
    const first = tracker.recordOperation({
      sessionId: "parent",
      path: "a.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z"
    });
    const snapshot = tracker.snapshotReads("parent", "2026-06-11T10:00:00.000Z");
    const second = tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "a.ts",
      operation: "write",
      sourceTool: "file.write",
      timestamp: "2026-06-11T10:00:00.000Z"
    });

    expect(first.sequence).toBe(1);
    expect(snapshot.capturedSequence).toBe(1);
    expect(second.sequence).toBe(2);
    expect(tracker.findWritesAfter({
      parentSessionId: "parent",
      childSessionId: "child",
      afterSequence: snapshot.capturedSequence,
      paths: ["a.ts"]
    })).toEqual([
      expect.objectContaining({
        sequence: 2,
        operation: "write"
      })
    ]);
  });

  it("queries child writes after a timestamp by path and relationship", () => {
    const tracker = new FileStateTracker();
    tracker.recordOperation({
      sessionId: "parent",
      path: "src/app.ts",
      operation: "read",
      sourceTool: "file.read",
      timestamp: "2026-06-11T10:00:00.000Z"
    });
    tracker.recordOperation({
      sessionId: "child-1",
      parentSessionId: "parent",
      childSessionId: "child-1",
      path: "./src/app.ts",
      operation: "write",
      sourceTool: "file.write",
      timestamp: "2026-06-11T10:02:00.000Z"
    });
    tracker.recordOperation({
      sessionId: "child-2",
      parentSessionId: "other-parent",
      childSessionId: "child-2",
      path: "src/app.ts",
      operation: "replace",
      sourceTool: "file.patch",
      timestamp: "2026-06-11T10:03:00.000Z"
    });

    expect(tracker.findWritesAfter({
      parentSessionId: "parent",
      childSessionId: "child-1",
      after: "2026-06-11T10:01:00.000Z",
      paths: ["src/app.ts"]
    })).toEqual([
      expect.objectContaining({
        sessionId: "child-1",
        operation: "write",
        normalizedPath: "src/app.ts"
      })
    ]);
  });

  it("filters by session, parent, child, operation, path, and time", () => {
    const tracker = new FileStateTracker();
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "src/app.ts",
      operation: "replace",
      sourceTool: "file.patch",
      timestamp: "2026-06-11T10:00:00.000Z"
    });
    tracker.recordOperation({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      path: "src/other.ts",
      operation: "write",
      sourceTool: "file.write",
      timestamp: "2026-06-11T10:05:00.000Z"
    });

    expect(tracker.listOperations({
      sessionId: "child",
      parentSessionId: "parent",
      childSessionId: "child",
      operation: ["write", "replace"],
      path: "src/other.ts",
      since: "2026-06-11T10:01:00.000Z",
      until: "2026-06-11T10:06:00.000Z"
    })).toEqual([
      expect.objectContaining({
        operation: "write",
        normalizedPath: "src/other.ts"
      })
    ]);
  });

  it("clears operations for one session without affecting others", () => {
    const tracker = new FileStateTracker();
    tracker.recordOperation({
      sessionId: "session-a",
      path: "a.ts",
      operation: "read",
      sourceTool: "file.read"
    });
    tracker.recordOperation({
      sessionId: "session-b",
      path: "b.ts",
      operation: "write",
      sourceTool: "file.write"
    });

    tracker.clearSession("session-a");

    expect(tracker.listOperations()).toEqual([
      expect.objectContaining({ sessionId: "session-b" })
    ]);
  });

  it("keeps independent tracker instances isolated", () => {
    const first = new FileStateTracker();
    const second = new FileStateTracker();
    first.recordOperation({
      sessionId: "session-a",
      path: "a.ts",
      operation: "read",
      sourceTool: "file.read"
    });

    expect(second.listOperations()).toEqual([]);
  });
});
