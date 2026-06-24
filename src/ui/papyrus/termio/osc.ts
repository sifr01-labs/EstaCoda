import { BEL, ESC, ESC_TYPE, SEP } from "./ansi.js";
import type { Action, Color, TabStatusAction } from "./types.js";

export const OSC_PREFIX = ESC + String.fromCharCode(ESC_TYPE.OSC);
export const ST = ESC + "\\";

export const OSC = {
  SET_TITLE_AND_ICON: 0,
  SET_ICON: 1,
  SET_TITLE: 2,
  SET_COLOR: 4,
  SET_CWD: 7,
  HYPERLINK: 8,
  ITERM2: 9,
  SET_FG_COLOR: 10,
  SET_BG_COLOR: 11,
  SET_CURSOR_COLOR: 12,
  RESET_COLOR: 104,
  RESET_FG_COLOR: 110,
  RESET_BG_COLOR: 111,
  RESET_CURSOR_COLOR: 112,
  SEMANTIC_PROMPT: 133,
  GHOSTTY: 777,
  TAB_STATUS: 21337,
} as const;

export function osc(...parts: (string | number)[]): string {
  return `${OSC_PREFIX}${parts.join(SEP)}${BEL}`;
}

export function link(url: string, params?: Record<string, string>): string {
  if (!url) return LINK_END;
  const p = { id: osc8Id(url), ...params };
  const paramString = Object.entries(p).map(([key, value]) => `${key}=${value}`).join(":");
  return osc(OSC.HYPERLINK, paramString, url);
}

function osc8Id(url: string): string {
  let hash = 0;
  for (let i = 0; i < url.length; i += 1) {
    hash = ((hash << 5) - hash + url.charCodeAt(i)) | 0;
  }
  return (hash >>> 0).toString(36);
}

export const LINK_END = osc(OSC.HYPERLINK, "", "");

export const ITERM2 = {
  NOTIFY: 0,
  BADGE: 2,
  PROGRESS: 4,
} as const;

export const PROGRESS = {
  CLEAR: 0,
  SET: 1,
  ERROR: 2,
  INDETERMINATE: 3,
} as const;

export const CLEAR_ITERM2_PROGRESS = `${OSC_PREFIX}${OSC.ITERM2};${ITERM2.PROGRESS};${PROGRESS.CLEAR};${BEL}`;
export const CLEAR_TERMINAL_TITLE = `${OSC_PREFIX}${OSC.SET_TITLE_AND_ICON};${BEL}`;
export const CLEAR_TAB_STATUS = osc(OSC.TAB_STATUS, "indicator=;status=;status-color=");

export function tabStatus(fields: TabStatusAction): string {
  const parts: string[] = [];
  const rgb = (color: Color) =>
    color.type === "rgb"
      ? `#${[color.r, color.g, color.b].map((channel) => channel.toString(16).padStart(2, "0")).join("")}`
      : "";

  if ("indicator" in fields) parts.push(`indicator=${fields.indicator ? rgb(fields.indicator) : ""}`);
  if ("status" in fields) parts.push(`status=${fields.status?.replaceAll("\\", "\\\\").replaceAll(";", "\\;") ?? ""}`);
  if ("statusColor" in fields) parts.push(`status-color=${fields.statusColor ? rgb(fields.statusColor) : ""}`);
  return osc(OSC.TAB_STATUS, parts.join(";"));
}

export function parseOSC(content: string): Action | null {
  const semicolonIndex = content.indexOf(";");
  const command = semicolonIndex >= 0 ? content.slice(0, semicolonIndex) : content;
  const data = semicolonIndex >= 0 ? content.slice(semicolonIndex + 1) : "";
  const commandNumber = Number.parseInt(command, 10);

  if (commandNumber === OSC.SET_TITLE_AND_ICON) return { type: "title", action: { type: "both", title: data } };
  if (commandNumber === OSC.SET_ICON) return { type: "title", action: { type: "iconName", name: data } };
  if (commandNumber === OSC.SET_TITLE) return { type: "title", action: { type: "windowTitle", title: data } };

  if (commandNumber === OSC.HYPERLINK) {
    const parts = data.split(";");
    const paramsString = parts[0] ?? "";
    const url = parts.slice(1).join(";");

    if (url === "") return { type: "link", action: { type: "end" } };

    const params: Record<string, string> = {};
    if (paramsString) {
      for (const pair of paramsString.split(":")) {
        const equalsIndex = pair.indexOf("=");
        if (equalsIndex >= 0) params[pair.slice(0, equalsIndex)] = pair.slice(equalsIndex + 1);
      }
    }

    return {
      type: "link",
      action: {
        type: "start",
        url,
        params: Object.keys(params).length > 0 ? params : undefined,
      },
    };
  }

  if (commandNumber === OSC.TAB_STATUS) return { type: "tabStatus", action: parseTabStatus(data) };

  return { type: "unknown", sequence: `${OSC_PREFIX}${content}` };
}

export function parseOscColor(spec: string): Color | null {
  const hex = spec.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (hex) {
    return { type: "rgb", r: Number.parseInt(hex[1]!, 16), g: Number.parseInt(hex[2]!, 16), b: Number.parseInt(hex[3]!, 16) };
  }

  const rgb = spec.match(/^rgb:([0-9a-f]{1,4})\/([0-9a-f]{1,4})\/([0-9a-f]{1,4})$/i);
  if (!rgb) return null;

  const scale = (value: string) => Math.round((Number.parseInt(value, 16) / (16 ** value.length - 1)) * 255);
  return { type: "rgb", r: scale(rgb[1]!), g: scale(rgb[2]!), b: scale(rgb[3]!) };
}

function parseTabStatus(data: string): TabStatusAction {
  const action: TabStatusAction = {};
  for (const [key, value] of splitTabStatusPairs(data)) {
    if (key === "indicator") action.indicator = value === "" ? null : parseOscColor(value);
    else if (key === "status") action.status = value === "" ? null : value;
    else if (key === "status-color") action.statusColor = value === "" ? null : parseOscColor(value);
  }
  return action;
}

function* splitTabStatusPairs(data: string): Generator<[string, string]> {
  let key = "";
  let value = "";
  let inValue = false;
  let escaped = false;

  for (const char of data) {
    if (escaped) {
      if (inValue) value += char;
      else key += char;
      escaped = false;
    } else if (char === "\\") {
      escaped = true;
    } else if (char === ";") {
      yield [key, value];
      key = "";
      value = "";
      inValue = false;
    } else if (char === "=" && !inValue) {
      inValue = true;
    } else if (inValue) {
      value += char;
    } else {
      key += char;
    }
  }

  if (key || inValue) yield [key, value];
}
