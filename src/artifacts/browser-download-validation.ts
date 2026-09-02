import { extname } from "node:path";

export type BrowserDownloadInspection =
  | { allowed: true; mimeType: string; kind: "data" | "document"; apiDescription?: { format: string; version?: string } }
  | { allowed: false; reason: string };

export function inspectBrowserDownload(filename: string, bytes: Uint8Array): BrowserDownloadInspection {
  const extension = extname(filename).toLowerCase();
  if (looksExecutableOrScript(bytes)) return { allowed: false, reason: "executable-or-script-content" };

  if (extension === ".pdf") {
    return startsWithAscii(bytes, "%PDF-")
      ? { allowed: true, mimeType: "application/pdf", kind: "document" }
      : { allowed: false, reason: "invalid-pdf-content" };
  }
  if (extension === ".zip") {
    return bytes.length >= 4 && bytes[0] === 0x50 && bytes[1] === 0x4b && [0x03, 0x05, 0x07].includes(bytes[2] ?? -1)
      ? { allowed: true, mimeType: "application/zip", kind: "data" }
      : { allowed: false, reason: "invalid-zip-content" };
  }
  if (![".json", ".yaml", ".yml", ".txt", ".md", ".csv", ".raml", ".graphql", ".gql", ".proto", ".smithy"].includes(extension)) {
    return { allowed: false, reason: "unsupported-download-type" };
  }
  if (!isSafeTextBytes(bytes)) return { allowed: false, reason: "binary-content-in-text-download" };
  if (extension === ".json") {
    try {
      const parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      const apiDescription = describeJsonApiDescription(parsed);
      return { allowed: true, mimeType: "application/json", kind: "data", ...(apiDescription === undefined ? {} : { apiDescription }) };
    } catch {
      return { allowed: false, reason: "invalid-json-content" };
    }
  }
  if (extension === ".yaml" || extension === ".yml") {
    const text = new TextDecoder().decode(bytes);
    const match = text.slice(0, 16_000).match(/^\s*(openapi|swagger|asyncapi)\s*:\s*["']?([^\s"']+)/imu);
    const apiDescription = match === null ? undefined : {
      format: match[1]!.toLowerCase() === "swagger" ? "Swagger" : match[1]!.toLowerCase() === "asyncapi" ? "AsyncAPI" : "OpenAPI",
      version: match[2]
    };
    return { allowed: true, mimeType: "application/yaml", kind: "data", ...(apiDescription === undefined ? {} : { apiDescription }) };
  }
  if (extension === ".raml") return { allowed: true, mimeType: "application/raml+yaml", kind: "data", apiDescription: { format: "RAML" } };
  if (extension === ".graphql" || extension === ".gql") return { allowed: true, mimeType: "application/graphql", kind: "data", apiDescription: { format: "GraphQL" } };
  if (extension === ".proto") return { allowed: true, mimeType: "text/x-protobuf", kind: "data", apiDescription: { format: "Protocol Buffers" } };
  if (extension === ".smithy") return { allowed: true, mimeType: "text/x-smithy", kind: "data", apiDescription: { format: "Smithy" } };
  if (extension === ".csv") return { allowed: true, mimeType: "text/csv", kind: "data" };
  if (extension === ".md") return { allowed: true, mimeType: "text/markdown", kind: "document" };
  return { allowed: true, mimeType: "text/plain", kind: "document" };
}

function describeJsonApiDescription(value: unknown): { format: string; version?: string } | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (typeof record.openapi === "string") return { format: "OpenAPI", version: record.openapi.slice(0, 32) };
  if (typeof record.swagger === "string") return { format: "Swagger", version: record.swagger.slice(0, 32) };
  if (typeof record.asyncapi === "string") return { format: "AsyncAPI", version: record.asyncapi.slice(0, 32) };
  const data = typeof record.data === "object" && record.data !== null ? record.data as Record<string, unknown> : undefined;
  if (record.__schema !== undefined || data?.__schema !== undefined) return { format: "GraphQL introspection" };
  return undefined;
}

function looksExecutableOrScript(bytes: Uint8Array): boolean {
  if (startsWithAscii(bytes, "MZ") || startsWithAscii(bytes, "\u007fELF") || startsWithAscii(bytes, "#!")) return true;
  if (bytes.length < 4) return false;
  const magic = [bytes[0], bytes[1], bytes[2], bytes[3]].map((value) => value?.toString(16).padStart(2, "0")).join("");
  return ["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe"].includes(magic);
}

function startsWithAscii(bytes: Uint8Array, value: string): boolean {
  const prefix = Buffer.from(value, "binary");
  return bytes.length >= prefix.length && prefix.every((byte, index) => bytes[index] === byte);
}

function isSafeTextBytes(bytes: Uint8Array): boolean {
  if (bytes.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}
