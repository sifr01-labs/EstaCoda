export type NamedColor =
  | "black"
  | "red"
  | "green"
  | "yellow"
  | "blue"
  | "magenta"
  | "cyan"
  | "white"
  | "brightBlack"
  | "brightRed"
  | "brightGreen"
  | "brightYellow"
  | "brightBlue"
  | "brightMagenta"
  | "brightCyan"
  | "brightWhite";

export type Color =
  | { type: "named"; name: NamedColor }
  | { type: "indexed"; index: number }
  | { type: "rgb"; r: number; g: number; b: number }
  | { type: "default" };

export type UnderlineStyle = "none" | "single" | "double" | "curly" | "dotted" | "dashed";

export type TextStyle = {
  bold: boolean;
  dim: boolean;
  italic: boolean;
  underline: UnderlineStyle;
  blink: boolean;
  inverse: boolean;
  hidden: boolean;
  strikethrough: boolean;
  overline: boolean;
  fg: Color;
  bg: Color;
  underlineColor: Color;
};

export function defaultStyle(): TextStyle {
  return {
    bold: false,
    dim: false,
    italic: false,
    underline: "none",
    blink: false,
    inverse: false,
    hidden: false,
    strikethrough: false,
    overline: false,
    fg: { type: "default" },
    bg: { type: "default" },
    underlineColor: { type: "default" },
  };
}

export type CursorDirection = "up" | "down" | "forward" | "back";

export type CursorAction =
  | { type: "move"; direction: CursorDirection; count: number }
  | { type: "position"; row: number; col: number }
  | { type: "column"; col: number }
  | { type: "row"; row: number }
  | { type: "save" }
  | { type: "restore" }
  | { type: "show" }
  | { type: "hide" }
  | { type: "style"; style: "block" | "underline" | "bar"; blinking: boolean }
  | { type: "nextLine"; count: number }
  | { type: "prevLine"; count: number };

export type EraseAction =
  | { type: "display"; region: "toEnd" | "toStart" | "all" | "scrollback" }
  | { type: "line"; region: "toEnd" | "toStart" | "all" }
  | { type: "chars"; count: number };

export type ScrollAction =
  | { type: "up"; count: number }
  | { type: "down"; count: number }
  | { type: "setRegion"; top: number; bottom: number };

export type ModeAction =
  | { type: "alternateScreen"; enabled: boolean }
  | { type: "bracketedPaste"; enabled: boolean }
  | { type: "mouseTracking"; mode: "off" | "normal" | "button" | "any" }
  | { type: "focusEvents"; enabled: boolean };

export type LinkAction = { type: "start"; url: string; params?: Record<string, string> } | { type: "end" };
export type TitleAction =
  | { type: "windowTitle"; title: string }
  | { type: "iconName"; name: string }
  | { type: "both"; title: string };

export type TabStatusAction = {
  indicator?: Color | null;
  status?: string | null;
  statusColor?: Color | null;
};

export type Grapheme = {
  value: string;
  width: 1 | 2;
};

export type Action =
  | { type: "text"; graphemes: Grapheme[]; style: TextStyle }
  | { type: "cursor"; action: CursorAction }
  | { type: "erase"; action: EraseAction }
  | { type: "scroll"; action: ScrollAction }
  | { type: "mode"; action: ModeAction }
  | { type: "link"; action: LinkAction }
  | { type: "title"; action: TitleAction }
  | { type: "tabStatus"; action: TabStatusAction }
  | { type: "sgr"; params: string }
  | { type: "bell" }
  | { type: "reset" }
  | { type: "unknown"; sequence: string };
