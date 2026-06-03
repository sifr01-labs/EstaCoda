import type { ChannelAttachment, ChannelMessage } from "../contracts/channel.js";
import type { LoadedRuntimeConfig } from "../config/runtime-config.js";
import { createHash } from "node:crypto";
import { validateAudioInput } from "../tools/audio-validation.js";
import type { FasterWhisperWorker } from "../tools/stt-local-whisper.js";
import { checkSttProviderStatus, isFasterWhisperConfig } from "../tools/stt-providers.js";
import { isGatewayFasterWhisperDownloadDenied } from "../tools/stt-providers.js";
import { resolveAllowedPath, transcribeAudioFile, type VoiceFetchLike } from "../tools/voice-tools.js";
import type { VoiceStateManager, TranscriptRecord } from "../gateway/voice-state.js";

export type VoiceTranscriptionAuditEvent = {
  timestamp: string;
  outcome: "allow" | "deny" | "fail";
  provider: LoadedRuntimeConfig["stt"]["provider"];
  reason?: string;
  attachment: {
    id: string;
    kind: string;
    status?: string;
    mimeType?: string;
    bytes?: number;
    pathHash?: string;
  };
};

export type ChannelVoiceTranscriptionOptions = {
  stt: LoadedRuntimeConfig["stt"];
  allowedRoots?: string[];
  fasterWhisperDefaultHfHome?: string;
  fetch?: VoiceFetchLike;
  localWhisper?: FasterWhisperWorker;
  voiceStateManager?: VoiceStateManager;
  audit?: (event: VoiceTranscriptionAuditEvent) => void | Promise<void>;
};

type InjectedTranscript = {
  attachmentId: string;
  text: string;
  hash: string;
  timestamp: string;
};

export async function injectVoiceTranscripts(
  message: ChannelMessage,
  options: ChannelVoiceTranscriptionOptions
): Promise<ChannelMessage> {
  const attachments = (message.attachments ?? []).filter(isReadyVoiceAttachment);
  if (attachments.length === 0) {
    return message;
  }

  const notes: string[] = [];
  const consumedAttachmentIds = new Set<string>();
  const transcriptMetadata: InjectedTranscript[] = [];
  for (const attachment of attachments) {
    const path = attachment.localPath ?? attachment.path;
    if (path === undefined || path.length === 0) {
      continue;
    }
    const resolvedPath = options.allowedRoots === undefined
      ? { ok: true as const, path }
      : await resolveAllowedPath(options.allowedRoots, path);
    if (!resolvedPath.ok) {
      await emitAudit(options, auditEvent("deny", options.stt, attachment, path, resolvedPath.content));
      notes.push(`[Voice transcript unavailable for ${attachmentLabel(attachment)}]\n${resolvedPath.content}`);
      continue;
    }
    const audioValidation = await validateAudioInput(resolvedPath.path);
    if (!audioValidation.ok) {
      await emitAudit(options, auditEvent("deny", options.stt, attachment, resolvedPath.path, audioValidation.content));
      notes.push(`[Voice transcript unavailable for ${attachmentLabel(attachment)}]\n${audioValidation.content}`);
      continue;
    }
    const status = checkSttProviderStatus(options.stt.provider, options.stt);
    if (!status.ready) {
      await emitAudit(options, auditEvent("deny", options.stt, attachment, resolvedPath.path, status.reason));
      notes.push(`[Voice transcript unavailable for ${attachmentLabel(attachment)}]\nSTT provider unavailable: ${status.reason}`);
      continue;
    }
    if (isGatewayFasterWhisperDownloadDenied(options.stt, undefined, options.fasterWhisperDefaultHfHome)) {
      const reason = "Gateway faster-whisper first-run model downloads are disabled";
      await emitAudit(options, auditEvent("deny", options.stt, attachment, resolvedPath.path, reason));
      notes.push(`[Voice transcript unavailable for ${attachmentLabel(attachment)}]\n${reason}`);
      continue;
    }
    if (isFasterWhisperConfig(options.stt) && options.localWhisper === undefined) {
      const reason = "faster-whisper STT requires a runtime-owned worker resource.";
      await emitAudit(options, auditEvent("deny", options.stt, attachment, resolvedPath.path, reason));
      notes.push(`[Voice transcript unavailable for ${attachmentLabel(attachment)}]\n${reason}`);
      continue;
    }
    await emitAudit(options, auditEvent("allow", options.stt, attachment, resolvedPath.path));

    const result = await transcribeAudioFile({
      path: resolvedPath.path,
      stt: options.stt,
      fetch: options.fetch,
      localWhisper: options.localWhisper,
      gateway: true,
      fasterWhisperDefaultHfHome: options.fasterWhisperDefaultHfHome
    });
    if (result.ok) {
      consumedAttachmentIds.add(attachment.id);
      if (options.voiceStateManager?.isDuplicateTranscript(message.sessionKey.platform, message.sessionKey.chatId, result.text) === true) {
        continue;
      }
      const record = options.voiceStateManager?.recordTranscript(message.sessionKey.platform, message.sessionKey.chatId, result.text) ??
        fallbackTranscriptRecord(result.text);
      notes.push(`[Voice message transcript]\n${result.text}`);
      transcriptMetadata.push({
        attachmentId: attachment.id,
        text: result.text,
        hash: record.hash,
        timestamp: record.timestamp
      });
    } else {
      await emitAudit(options, auditEvent("fail", options.stt, attachment, resolvedPath.path, result.content));
      notes.push(`[Voice transcript unavailable for ${attachmentLabel(attachment)}]\n${result.content}`);
    }
  }

  if (notes.length === 0 && consumedAttachmentIds.size === 0) {
    return message;
  }
  const remainingAttachments = (message.attachments ?? []).filter((attachment) => !consumedAttachmentIds.has(attachment.id));

  return {
    ...message,
    text: [message.text.trim(), ...notes].filter((part) => part.length > 0).join("\n\n"),
    attachments: remainingAttachments,
    metadata: {
      ...(message.metadata ?? {}),
      voiceTranscription: {
        injected: true,
        count: notes.length,
        ...(transcriptMetadata.length > 0 ? { transcripts: transcriptMetadata } : {})
      }
    }
  };
}

function isReadyVoiceAttachment(attachment: ChannelAttachment): boolean {
  return (attachment.kind === "audio" || attachment.kind === "voice") &&
    (attachment.status === undefined || attachment.status === "ready");
}

function attachmentLabel(attachment: ChannelAttachment): string {
  return attachment.originalName ?? attachment.name ?? attachment.id;
}

function auditEvent(
  outcome: VoiceTranscriptionAuditEvent["outcome"],
  stt: LoadedRuntimeConfig["stt"],
  attachment: ChannelAttachment,
  path: string,
  reason?: string
): VoiceTranscriptionAuditEvent {
  return {
    timestamp: new Date().toISOString(),
    outcome,
    provider: stt.provider,
    reason,
    attachment: {
      id: attachment.id,
      kind: attachment.kind,
      status: attachment.status,
      mimeType: attachment.mimeType,
      bytes: attachment.bytes,
      pathHash: hashPath(path)
    }
  };
}

async function emitAudit(
  options: ChannelVoiceTranscriptionOptions,
  event: VoiceTranscriptionAuditEvent
): Promise<void> {
  await options.audit?.(event);
}

function hashPath(path: string): string {
  return createHash("sha256").update(path).digest("hex").slice(0, 16);
}

function fallbackTranscriptRecord(text: string): TranscriptRecord {
  const hash = createHash("sha256").update(text.trim().toLowerCase()).digest("hex").slice(0, 16);
  return {
    normalized: text,
    hash,
    timestamp: new Date().toISOString()
  };
}
