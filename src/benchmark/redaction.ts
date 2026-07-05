import { redactObject, redactString } from "../utils/redaction.js";

export function redactBenchmarkArtifact<T>(value: T): T {
  return redactObject(value) as T;
}

export function redactBenchmarkText(value: string): string {
  return redactString(value);
}

export function stripBenchmarkAnsi(value: string): string {
  return value.replace(
    // eslint-disable-next-line no-control-regex
    /[\u001B\u009B][[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/gu,
    ""
  ).replace(
    /\\u00(?:1[Bb]|9[Bb])[[\]()#;?]*(?:\d{1,4}(?:[;:]\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]/gu,
    ""
  );
}
