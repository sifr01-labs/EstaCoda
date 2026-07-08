import { existsSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { ChannelAttachment, ChannelKind } from "../contracts/channel.js";
import type { IntentRoute } from "../contracts/intent.js";
import type { ModelProfile } from "../contracts/provider.js";
import type { LoadedSkill, SelectedSkillPromptContent, SkillDefinition } from "../contracts/skill.js";
import { selectSkillPromptContent } from "../skills/skill-contract.js";
import {
  resolveSkillSetupContext,
  type SkillSetupContext
} from "../skills/skill-readiness.js";
import type { IntentRouter } from "./intent-router.js";
export type { SkillSetupContext } from "../skills/skill-readiness.js";

export type RuntimeRouteResult = {
  intent: IntentRoute;
  selectedSkill: LoadedSkill | SkillDefinition | undefined;
  selectedSkillPromptContent: SelectedSkillPromptContent | undefined;
  selectedSkillInstructions: string | undefined;
  selectedSkillResources: LoadedSkill["resources"] | undefined;
  selectedSkillSetup: SkillSetupContext | undefined;
  attachments: ChannelAttachment[] | undefined;
  attachmentFailureResponse?: string;
};

export type RuntimeRouterOptions = {
  intentRouter: IntentRouter;
  skillConfig: Record<string, Record<string, unknown>>;
};

export class RuntimeRouter {
  readonly #intentRouter: IntentRouter;
  readonly #skillConfig: Record<string, Record<string, unknown>>;

  constructor(options: RuntimeRouterOptions) {
    this.#intentRouter = options.intentRouter;
    this.#skillConfig = options.skillConfig;
  }

  route(input: {
    text: string;
    attachments?: ChannelAttachment[];
    channel: ChannelKind;
    model?: ModelProfile;
    trustedWorkspace?: boolean;
  }): RuntimeRouteResult {
    const attachments = normalizeAttachments(input.attachments);
    const attachmentFailureResponse = buildAttachmentFailureResponse(attachments);

    if (attachmentFailureResponse !== undefined) {
      return {
        intent: directAttachmentFailureIntent(),
        selectedSkill: undefined,
        selectedSkillPromptContent: undefined,
        selectedSkillInstructions: undefined,
        selectedSkillResources: undefined,
        selectedSkillSetup: undefined,
        attachments,
        attachmentFailureResponse
      };
    }

    const intent = this.#intentRouter.route(input.text, {
      attachments,
      channel: input.channel,
      surface: input.channel,
      model: input.model,
      trustedWorkspace: input.trustedWorkspace ?? false
    });

    const selectedSkill = intent.primarySkill ?? intent.suggestedSkills[0];
    const selectedSkillPromptContent =
      selectedSkill === undefined || !isLoadedSkill(selectedSkill)
        ? undefined
        : selectSkillPromptContent(selectedSkill);
    const selectedSkillInstructions = selectedSkillPromptContent?.content;
    const selectedSkillResources =
      selectedSkill === undefined || !isLoadedSkill(selectedSkill)
        ? undefined
        : selectedSkill.resources;
    const selectedSkillSetup =
      selectedSkill === undefined
        ? undefined
        : resolveSkillSetupContext(selectedSkill, this.#skillConfig[selectedSkill.name]);

    return {
      intent,
      selectedSkill,
      selectedSkillPromptContent,
      selectedSkillInstructions,
      selectedSkillResources,
      selectedSkillSetup,
      attachments
    };
  }
}

export function isLoadedSkill(skill: LoadedSkill | SkillDefinition): skill is LoadedSkill {
  return "instructions" in skill && "sourcePath" in skill;
}

export function normalizeAttachments(
  attachments: ChannelAttachment[] | undefined
): ChannelAttachment[] | undefined {
  if (attachments === undefined || attachments.length === 0) {
    return attachments;
  }

  return attachments.map((attachment) => {
    const inferredStatus = inferAttachmentStatus(attachment);
    if (inferredStatus !== "ready") {
      return {
        ...attachment,
        status: inferredStatus
      };
    }

    const localPath = attachment.localPath ?? attachment.path;
    if (
      typeof localPath === "string" &&
      localPath.length > 0 &&
      isAbsolute(localPath) &&
      !existsSync(localPath)
    ) {
      return {
        ...attachment,
        status: "missing-file",
        failureCode: attachment.failureCode ?? "attachment-missing-file",
        failureMessage:
          attachment.failureMessage ??
          "I couldn't access the downloaded attachment anymore. Please resend it and I'll inspect it again."
      };
    }

    return {
      ...attachment,
      status: "ready"
    };
  });
}

export function summarizeAttachments(
  attachments: ChannelAttachment[] | undefined
): Array<Record<string, unknown>> {
  return (attachments ?? []).map((attachment) => ({
    id: attachment.id,
    kind: attachment.kind,
    status: attachment.status ?? inferAttachmentStatus(attachment),
    name: attachment.originalName ?? attachment.name,
    path: attachment.localPath ?? attachment.path,
    remoteUrl: attachment.remoteUrl ?? attachment.url,
    mimeType: attachment.mimeType,
    bytes: attachment.bytes,
    failureCode: attachment.failureCode,
    failureMessage: attachment.failureMessage
  }));
}

function inferAttachmentStatus(
  attachment: ChannelAttachment
): NonNullable<ChannelAttachment["status"]> {
  return attachment.status ?? "ready";
}

function buildAttachmentFailureResponse(
  attachments: ChannelAttachment[] | undefined
): string | undefined {
  if (attachments === undefined || attachments.length === 0) {
    return undefined;
  }

  const failed = attachments.filter((attachment) => inferAttachmentStatus(attachment) !== "ready");
  const ready = attachments.filter((attachment) => inferAttachmentStatus(attachment) === "ready");
  if (failed.length === 0 || ready.length > 0) {
    return undefined;
  }

  const statuses = new Set(failed.map((attachment) => inferAttachmentStatus(attachment)));
  if (statuses.size === 1) {
    const status = failed[0] === undefined ? "download-failed" : inferAttachmentStatus(failed[0]);
    if (status === "unsupported") {
      return (
        failed[0]?.failureMessage ??
        "I can't inspect this attachment type yet. Try sending an image, PDF, or text-like document."
      );
    }

    if (status === "too-large") {
      return (
        failed[0]?.failureMessage ??
        "That attachment is too large for this workflow right now. Please send a smaller file and try again."
      );
    }

    if (status === "missing-file") {
      return "I couldn't access the downloaded attachment anymore. Please resend it and I'll inspect it again.";
    }
  }

  return (
    "I couldn't inspect the attachment. Please resend it as an image, PDF, or smaller supported document and I'll try again."
  );
}

function directAttachmentFailureIntent(): IntentRoute {
  return {
    nativeIntent: "general",
    taskClass: "general",
    labels: ["general"],
    confidence: 1,
    suggestedToolsets: [],
    supportingSkills: [],
    candidates: [],
    rejectedCandidates: [],
    suggestedSkills: [],
    confirmationRequired: false,
    evidence: [
      {
        kind: "attachment",
        detail: "Attachment preflight failed before routing.",
        weight: 1
      }
    ],
    rationale: "EstaCoda handled a channel attachment failure before provider/tool execution."
  };
}
