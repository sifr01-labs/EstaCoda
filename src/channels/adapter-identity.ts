import type {
  TelegramChannelConfig,
  DiscordChannelConfig,
  EmailChannelConfig,
  WhatsAppChannelConfig,
} from "../config/runtime-config.js";
import { deriveIdentityHash } from "../gateway/identity-lock.js";
import { resolve } from "node:path";
import type { ChannelKind } from "../contracts/channel.js";

type GatewayStateHome = string | { gatewayStatePath: string };

export type AdapterIdentityMaterial = {
  kind: ChannelKind;
  value: string;
};

function resolveToken(botTokenEnv?: string): string | undefined {
  if (botTokenEnv === undefined) return undefined;
  const value = process.env[botTokenEnv];
  if (value === undefined) return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

export function resolveTelegramIdentityMaterial(config: TelegramChannelConfig): AdapterIdentityMaterial | undefined {
  if (config.enabled !== true) return undefined;
  const token = resolveToken(config.botTokenEnv);
  if (token === undefined) return undefined;
  return { kind: "telegram", value: token };
}

export function resolveDiscordIdentityMaterial(config: DiscordChannelConfig): AdapterIdentityMaterial | undefined {
  if (config.enabled !== true) return undefined;
  const token = resolveToken(config.botTokenEnv);
  if (token === undefined) return undefined;
  return { kind: "discord", value: token };
}

export function resolveEmailIdentityMaterial(config: EmailChannelConfig): AdapterIdentityMaterial | undefined {
  if (config.enabled !== true) return undefined;
  const username = (config.username ?? "").trim().toLowerCase();
  const ownAddress = (config.ownAddress ?? "").trim().toLowerCase();
  const imapHost = (config.imapHost ?? "").trim().toLowerCase();
  if (username.length === 0 || ownAddress.length === 0 || imapHost.length === 0) {
    return undefined;
  }
  return { kind: "email", value: `${username}:${ownAddress}:${imapHost}` };
}

export function resolveWhatsAppIdentityMaterial(config: WhatsAppChannelConfig): AdapterIdentityMaterial | undefined {
  if (config.enabled !== true) return undefined;
  const authDir = (config.authDir ?? "").trim();
  if (authDir.length === 0) return undefined;
  return { kind: "whatsapp", value: resolve(authDir) };
}

export async function deriveTelegramIdentityHash(
  stateHome: GatewayStateHome,
  config: TelegramChannelConfig
): Promise<string | undefined> {
  const material = resolveTelegramIdentityMaterial(config);
  if (material === undefined) return undefined;
  return deriveIdentityHash(stateHome, material.kind, material.value);
}

export async function deriveDiscordIdentityHash(
  stateHome: GatewayStateHome,
  config: DiscordChannelConfig
): Promise<string | undefined> {
  const material = resolveDiscordIdentityMaterial(config);
  if (material === undefined) return undefined;
  return deriveIdentityHash(stateHome, material.kind, material.value);
}

export async function deriveEmailIdentityHash(
  stateHome: GatewayStateHome,
  config: EmailChannelConfig
): Promise<string | undefined> {
  const material = resolveEmailIdentityMaterial(config);
  if (material === undefined) return undefined;
  return deriveIdentityHash(stateHome, material.kind, material.value);
}

export async function deriveWhatsAppIdentityHash(
  stateHome: GatewayStateHome,
  config: WhatsAppChannelConfig
): Promise<string | undefined> {
  const material = resolveWhatsAppIdentityMaterial(config);
  if (material === undefined) return undefined;
  return deriveIdentityHash(stateHome, material.kind, material.value);
}
