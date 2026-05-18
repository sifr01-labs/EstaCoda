import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { Client, GatewayIntentBits, Events } from "discord.js";
import type { TextBasedChannel, Message } from "discord.js";
import type { ArtifactRecord } from "../contracts/artifact.js";
import type {
  AdapterCapability,
  ChannelAdapter,
  ChannelAttachment,
  ChannelAttachmentKind,
  ChannelMessage,
  ChannelSessionKey,
  ChannelTextAction,
  ChannelTextOptions,
} from "../contracts/channel.js";
import type { RuntimeEvent } from "../contracts/runtime-event.js";
import type { DiscordChannelConfig } from "../config/runtime-config.js";
import { buildAdapterCapability } from "./adapter-capability.js";
import { renderChannelProgressLabel } from "./activity-labels.js";

export type DiscordAdapterOptions = {
  botToken: string;
  allowedUsers?: string[];
  allowedGuilds?: string[];
  allowedChannels?: string[];
  freeResponseChannels?: string[];
  mediaRoot?: string;
  maxTextLength?: number;
  now?: () => Date;
  clientFactory?: (options: { intents: number[] }) => Client;
  enabled?: boolean;
  missing?: string[];
};

export class DiscordAdapter implements ChannelAdapter {
  kind = "discord" as const;
  running = false;

  private client?: Client;
  private handler?: (message: ChannelMessage) => Promise<void>;
  private options: DiscordAdapterOptions;
  private config: DiscordChannelConfig;
  private missing: string[] | undefined;

  constructor(options: DiscordAdapterOptions) {
    this.options = options;
    this.missing = options.missing;
    this.config = {
      enabled: options.enabled ?? true,
      allowedUsers: options.allowedUsers,
      allowedGuilds: options.allowedGuilds,
      allowedChannels: options.allowedChannels,
      freeResponseChannels: options.freeResponseChannels,
    };
  }

  getCapabilities(): AdapterCapability {
    return buildAdapterCapability({ kind: "discord", config: this.config, missing: this.missing });
  }

  async start(handler: (message: ChannelMessage) => Promise<void>): Promise<void> {
    if (this.running) return;
    this.handler = handler;
    this.running = true;

    const intents = [GatewayIntentBits.MessageContent, GatewayIntentBits.GuildMembers];

    if (this.options.clientFactory) {
      this.client = this.options.clientFactory({ intents });
    } else {
      this.client = new Client({ intents });
    }

    this.client.on(Events.MessageCreate, this.handleMessage.bind(this));
    this.client.on(Events.InteractionCreate, this.handleInteraction.bind(this));

    await this.client.login(this.options.botToken);
  }

  async stop(): Promise<void> {
    if (!this.running) return;
    this.running = false;
    if (this.client) {
      this.client.destroy();
      this.client = undefined;
    }
    this.handler = undefined;
  }

  get delivery() {
    return {
      sendText: async (sessionKey: ChannelSessionKey, text: string, options?: ChannelTextOptions) => {
        if (!this.client) throw new Error("Discord client not started");
        const channel = await this.client.channels.fetch(sessionKey.chatId);
        if (!channel || !isSendableChannel(channel)) {
          throw new Error(`Channel ${sessionKey.chatId} not found or not text-based`);
        }
        const sendable = channel as any;
        const chunks = chunkDiscordText(text, this.options.maxTextLength ?? 2000);
        const components = discordComponentsFromActions(options?.actions);
        for (const [index, chunk] of chunks.entries()) {
          try {
            await sendable.sendTyping();
          } catch {
            // ignore typing errors
          }
          await sendable.send({
            content: chunk,
            allowedMentions: { parse: [] },
            components: index === chunks.length - 1 ? components : undefined,
          });
        }
      },

      sendProgress: async (sessionKey: ChannelSessionKey, event: RuntimeEvent) => {
        if (!this.client) return;
        const rendered = renderChannelProgressLabel(event);
        if (!rendered) return;
        const channel = await this.client.channels.fetch(sessionKey.chatId);
        if (!channel || !isSendableChannel(channel)) return;
        const sendable = channel as any;
        await sendable.send({
          content: rendered,
          allowedMentions: { parse: [] },
        });
      },

      sendArtifact: async (sessionKey: ChannelSessionKey, artifact: ArtifactRecord) => {
        if (!this.client) return;
        const channel = await this.client.channels.fetch(sessionKey.chatId);
        if (!channel || !isSendableChannel(channel)) return;
        const sendable = channel as any;
        const caption = renderArtifactNotice(artifact);
        const filePath = artifact.localPath ?? artifact.path;
        if (filePath) {
          await sendable.send({
            content: caption,
            files: [filePath],
            allowedMentions: { parse: [] },
          });
        } else {
          await sendable.send({
            content: caption,
            allowedMentions: { parse: [] },
          });
        }
      },
    };
  }

  private async handleMessage(message: Message): Promise<void> {
    if (message.author.bot) return;
    if (!this.handler) return;

    // Allowed users filter
    if (this.options.allowedUsers && this.options.allowedUsers.length > 0) {
      if (!this.options.allowedUsers.includes(message.author.id)) return;
    }

    // Allowed guilds filter
    if (this.options.allowedGuilds && this.options.allowedGuilds.length > 0) {
      if (!message.guildId || !this.options.allowedGuilds.includes(message.guildId)) return;
    }

    // Allowed channels filter
    if (this.options.allowedChannels && this.options.allowedChannels.length > 0) {
      if (!this.options.allowedChannels.includes(message.channelId)) return;
    }

    // Mention / free-response check for non-DMs
    const isDM = message.guild === null;
    if (!isDM) {
      const isFreeResponse = this.options.freeResponseChannels?.includes(message.channelId) ?? false;
      if (!isFreeResponse) {
        const botId = this.client?.user?.id;
        const isMentioned = botId ? message.mentions.has(botId) : false;
        if (!isMentioned) return;
      }
    }

    const sessionKey = this.buildSessionKey(message);

    const attachments: ChannelAttachment[] = [];
    for (const [, attachment] of message.attachments) {
      if (this.options.mediaRoot) {
        try {
          const response = await fetch(attachment.url);
          if (!response.ok) throw new Error(`HTTP ${response.status}`);
          const buffer = Buffer.from(await response.arrayBuffer());
          const dir = join(this.options.mediaRoot, "discord");
          await mkdir(dir, { recursive: true });
          const fileName = `${randomUUID()}-${attachment.name}`;
          const localPath = join(dir, fileName);
          await writeFile(localPath, buffer);
          attachments.push({
            id: attachment.id,
            kind: guessAttachmentKind(attachment.contentType),
            status: "ready",
            mimeType: attachment.contentType ?? undefined,
            originalName: attachment.name,
            localPath,
            bytes: buffer.length,
          });
        } catch (err) {
          attachments.push({
            id: attachment.id,
            kind: "unknown",
            status: "download-failed",
            failureCode: "discord_attachment_download_failed",
            failureMessage: (err as Error).message,
            remoteUrl: attachment.url,
          });
        }
      } else {
        attachments.push({
          id: attachment.id,
          kind: guessAttachmentKind(attachment.contentType),
          remoteUrl: attachment.url,
          mimeType: attachment.contentType ?? undefined,
          originalName: attachment.name,
          bytes: attachment.size,
        });
      }
    }

    const channelMessage: ChannelMessage = {
      id: message.id,
      channel: "discord",
      sessionKey,
      text: message.content,
      sender: {
        id: message.author.id,
        displayName: message.author.displayName ?? message.author.username,
        username: message.author.username,
      },
      attachments: attachments.length > 0 ? attachments : undefined,
      receivedAt: this.options.now?.().toISOString() ?? new Date().toISOString(),
      metadata: {
        guildId: message.guildId,
        channelId: message.channelId,
      },
    };

    try {
      await this.handler(channelMessage);
    } catch {
      // Swallow handler errors to keep the client alive
    }
  }

  private buildSessionKey(message: Message): ChannelSessionKey {
    const isDM = message.guild === null;
    if (isDM) {
      return {
        platform: "discord",
        chatId: message.author.id,
        chatType: "dm",
        userId: message.author.id,
      };
    }

    if ("isThread" in message.channel && (message.channel as any).isThread?.()) {
      return {
        platform: "discord",
        chatId: message.channelId,
        chatType: "thread",
        userId: message.author.id,
      };
    }

    return {
      platform: "discord",
      chatId: message.channelId,
      chatType: "channel",
      userId: message.author.id,
    };
  }

  private async handleInteraction(interaction: any): Promise<void> {
    if (interaction.isButton?.()) {
      await this.handleButtonInteraction(interaction);
      return;
    }

    if (interaction.isChatInputCommand?.()) {
      console.warn(`[discord] Slash commands not implemented. Received: ${interaction.commandName}`);
    }
  }

  private async handleButtonInteraction(interaction: any): Promise<void> {
    if (!this.handler || typeof interaction.customId !== "string" || interaction.customId.length === 0) {
      await acknowledgeDiscordInteraction(interaction);
      return;
    }

    const senderId = String(interaction.user?.id ?? "");
    const channelId = String(interaction.channelId ?? "");
    const isDM = interaction.guildId === undefined || interaction.guildId === null;
    const sessionKey: ChannelSessionKey = isDM
      ? {
          platform: "discord",
          chatId: senderId || channelId,
          chatType: "dm",
          userId: senderId
        }
      : interaction.channel?.isThread?.()
        ? {
            platform: "discord",
            chatId: channelId,
            chatType: "thread",
            userId: senderId
          }
        : {
            platform: "discord",
            chatId: channelId,
            chatType: "channel",
            userId: senderId
          };

    const channelMessage: ChannelMessage = {
      id: `discord-interaction-${interaction.id ?? Date.now()}`,
      channel: "discord",
      sessionKey,
      text: interaction.customId,
      sender: {
        id: senderId,
        displayName: interaction.member?.displayName ?? interaction.user?.displayName ?? interaction.user?.username,
        username: interaction.user?.username
      },
      attachments: [],
      receivedAt: this.options.now?.().toISOString() ?? new Date().toISOString(),
      metadata: {
        guildId: interaction.guildId ?? undefined,
        channelId,
        interactionId: interaction.id,
      }
    };

    try {
      await acknowledgeDiscordInteraction(interaction);
      await this.handler(channelMessage);
    } catch {
      // Keep interaction handling from taking down the adapter.
    }
  }
}

function isSendableChannel(channel: unknown): channel is any {
  return (
    typeof channel === "object" &&
    channel !== null &&
    "send" in channel &&
    typeof (channel as any).send === "function"
  );
}

function chunkDiscordText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    let end = Math.min(i + maxLen, text.length);
    const nl = text.lastIndexOf("\n", end);
    if (nl > i && nl >= end - 200) {
      end = nl;
    } else {
      const sp = text.lastIndexOf(" ", end);
      if (sp > i && sp >= end - 100) {
        end = sp;
      }
    }
    chunks.push(text.slice(i, end));
    i = end + (text[end] === "\n" || text[end] === " " ? 1 : 0);
  }
  return chunks;
}

function discordComponentsFromActions(actions: ChannelTextAction[][] | undefined): unknown[] | undefined {
  if (actions === undefined || actions.length === 0) {
    return undefined;
  }

  return actions.map((row) => ({
    type: 1,
    components: row.map((action) => ({
      type: 2,
      style: 2,
      label: action.label.slice(0, 80),
      custom_id: action.value.slice(0, 100)
    }))
  }));
}

async function acknowledgeDiscordInteraction(interaction: any): Promise<void> {
  try {
    if (interaction.deferred !== true && interaction.replied !== true && typeof interaction.deferUpdate === "function") {
      await interaction.deferUpdate();
    }
  } catch {
    // Presentation-only acknowledgement; gateway command routing is independent.
  }
}

function guessAttachmentKind(contentType: string | null): ChannelAttachmentKind {
  if (!contentType) return "unknown";
  if (contentType.startsWith("image/")) return "image";
  if (contentType.startsWith("video/")) return "video";
  if (contentType.startsWith("audio/")) return "audio";
  if (contentType.startsWith("text/")) return "document";
  return "file";
}

function renderArtifactNotice(artifact: ArtifactRecord): string {
  const parts: string[] = [];
  parts.push(`Artifact: ${artifact.id}`);
  if (artifact.path) parts.push(`Path: ${artifact.path}`);
  if (artifact.mimeType) parts.push(`Type: ${artifact.mimeType}`);
  if (artifact.kind) parts.push(`Kind: ${artifact.kind}`);
  return parts.join("\n");
}
