export const ESC = "\x1b";
export const BEL = "\x07";
export const SEP = ";";

export const C0 = {
  NUL: 0x00,
  BEL: 0x07,
  BS: 0x08,
  HT: 0x09,
  LF: 0x0a,
  VT: 0x0b,
  FF: 0x0c,
  CR: 0x0d,
  ESC: 0x1b,
  DEL: 0x7f,
} as const;

export const ESC_TYPE = {
  CSI: 0x5b,
  OSC: 0x5d,
  DCS: 0x50,
  APC: 0x5f,
  PM: 0x5e,
  SOS: 0x58,
  ST: 0x5c,
} as const;

export function isC0(byte: number): boolean {
  return byte < 0x20 || byte === C0.DEL;
}

export function isEscFinal(byte: number): boolean {
  return byte >= 0x30 && byte <= 0x7e;
}
