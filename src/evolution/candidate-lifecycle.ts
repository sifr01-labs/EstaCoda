import type { EvolutionChangeManifest } from "../contracts/evolution.js";

export type LifecycleAction = "test" | "approve" | "reject" | "promote" | "rollback";

export function canTransition(
  from: EvolutionChangeManifest["status"],
  action: LifecycleAction
): { ok: true } | { ok: false; reason: string } {
  switch (action) {
    case "test":
      if (from === "proposed") {
        return { ok: true };
      }
      return { ok: false, reason: `Cannot test manifest from status '${from}'. Only 'proposed' manifests can be tested.` };

    case "approve":
      if (from === "testing") {
        return { ok: true };
      }
      return { ok: false, reason: `Cannot approve manifest from status '${from}'. Only 'testing' manifests can be approved.` };

    case "reject":
      if (from === "proposed" || from === "testing") {
        return { ok: true };
      }
      return { ok: false, reason: `Cannot reject manifest from status '${from}'. Only 'proposed' or 'testing' manifests can be rejected.` };

    case "promote":
      if (from === "approved") {
        return { ok: true };
      }
      return { ok: false, reason: `Manifest must be explicitly approved before promotion.` };

    case "rollback":
      if (from === "promoted") {
        return { ok: true };
      }
      if (from === "approved") {
        return { ok: false, reason: `Manifest has not been promoted. Nothing to rollback.` };
      }
      return { ok: false, reason: `Cannot rollback manifest from status '${from}'. Only 'promoted' manifests can be rolled back.` };

    default:
      return { ok: false, reason: `Unknown lifecycle action: ${action}` };
  }
}
