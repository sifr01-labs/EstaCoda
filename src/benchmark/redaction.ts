import { redactObject, redactString } from "../utils/redaction.js";

export function redactBenchmarkArtifact<T>(value: T): T {
  return redactObject(value) as T;
}

export function redactBenchmarkText(value: string): string {
  return redactString(value);
}
