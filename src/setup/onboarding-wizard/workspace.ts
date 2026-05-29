import { realpath, stat } from "node:fs/promises";

export type OnboardingWorkspaceValidationResult =
  | {
      readonly ok: true;
      readonly inputPath: string;
      readonly canonicalPath: string;
    }
  | {
      readonly ok: false;
      readonly inputPath: string;
      readonly reason: OnboardingWorkspaceValidationFailureReason;
      readonly message: string;
    };

export type OnboardingWorkspaceValidationFailureReason =
  | "missing"
  | "not-directory"
  | "realpath-failed";

export type OnboardingInvalidWorkspaceAction =
  | "try-again"
  | "use-current"
  | "cancel";

export async function validateOnboardingWorkspacePath(
  inputPath: string
): Promise<OnboardingWorkspaceValidationResult> {
  try {
    const stats = await stat(inputPath);
    if (!stats.isDirectory()) {
      return failure(inputPath, "not-directory");
    }
  } catch {
    return failure(inputPath, "missing");
  }

  try {
    return {
      ok: true,
      inputPath,
      canonicalPath: await realpath(inputPath),
    };
  } catch {
    return failure(inputPath, "realpath-failed");
  }
}

function failure(
  inputPath: string,
  reason: OnboardingWorkspaceValidationFailureReason
): Extract<OnboardingWorkspaceValidationResult, { readonly ok: false }> {
  switch (reason) {
    case "missing":
      return {
        ok: false,
        inputPath,
        reason,
        message: `Workspace path does not exist: ${inputPath}`,
      };
    case "not-directory":
      return {
        ok: false,
        inputPath,
        reason,
        message: `Workspace path is not a directory: ${inputPath}`,
      };
    case "realpath-failed":
      return {
        ok: false,
        inputPath,
        reason,
        message: `Workspace path could not be resolved: ${inputPath}`,
      };
  }
}
