import type { ProviderImageInput } from "../contracts/provider-usage.js";
import type { ProviderMessageContentPart } from "../contracts/provider.js";
import type { ToolResult } from "../contracts/tool.js";

export type EphemeralVisionDelivery = "initial" | "continuation";

export type EphemeralVisionImage = {
  content: Extract<ProviderMessageContentPart, { type: "image_url" }>;
  usage: ProviderImageInput;
  delivery: EphemeralVisionDelivery;
  attachmentId?: string;
};

const imagesByResult = new WeakMap<ToolResult, readonly EphemeralVisionImage[]>();
const handledAttachmentIdsByResult = new WeakMap<ToolResult, ReadonlySet<string>>();

export function attachEphemeralVisionImages<T extends ToolResult>(
  result: T,
  images: readonly EphemeralVisionImage[]
): T {
  imagesByResult.set(result, images.map((image) => ({ ...image })));
  const attachmentIds = images
    .map((image) => image.attachmentId)
    .filter((id): id is string => id !== undefined);
  if (attachmentIds.length > 0) {
    handledAttachmentIdsByResult.set(result, new Set(attachmentIds));
  }
  return result;
}

export function inheritEphemeralVisionImages<T extends ToolResult>(
  result: T,
  source: ToolResult
): T {
  const images = imagesByResult.get(source);
  if (images !== undefined) {
    imagesByResult.set(result, images.map((image) => ({ ...image })));
  }
  const handledAttachmentIds = handledAttachmentIdsByResult.get(source);
  if (handledAttachmentIds !== undefined) {
    handledAttachmentIdsByResult.set(result, new Set(handledAttachmentIds));
  }
  return result;
}

export function ephemeralVisionImages(
  result: ToolResult | undefined,
  delivery?: EphemeralVisionDelivery
): readonly EphemeralVisionImage[] {
  const images = result === undefined ? undefined : imagesByResult.get(result);
  return delivery === undefined ? images ?? [] : (images ?? []).filter((image) => image.delivery === delivery);
}

export function setEphemeralVisionDelivery(
  result: ToolResult | undefined,
  delivery: EphemeralVisionDelivery
): void {
  if (result === undefined) return;
  const images = imagesByResult.get(result);
  if (images === undefined) return;
  imagesByResult.set(result, images.map((image) => ({ ...image, delivery })));
}

export function markVisionAttachmentHandled(result: ToolResult | undefined, attachmentId: string): void {
  if (result === undefined) return;
  handledAttachmentIdsByResult.set(result, new Set([
    ...(handledAttachmentIdsByResult.get(result) ?? []),
    attachmentId
  ]));
  const images = imagesByResult.get(result);
  if (images !== undefined) {
    imagesByResult.set(result, images.map((image) => ({ ...image, attachmentId })));
  }
}

export function handledVisionAttachmentIds(result: ToolResult | undefined): ReadonlySet<string> {
  return result === undefined ? new Set() : handledAttachmentIdsByResult.get(result) ?? new Set();
}
