import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { promisify } from "node:util";
import { lstat } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { DOCKER_IMAGE_LABEL, DOCKER_IMAGE_TAG } from "./docker-policy.js";
const execute = promisify(execFile);

/** Private operator Docker transport. No workspace-supplied flags or remote daemon. */
export class DockerClient {
  constructor(readonly endpoint: string) {
    if (!endpoint.startsWith("unix:///") || /[\r\n\0]/u.test(endpoint)) throw new Error("Docker execution requires a local Unix socket.");
  }
  static async connect(): Promise<DockerClient> {
    let endpoint = process.env.DOCKER_HOST;
    if (!endpoint) {
      const result = await execute("docker", ["context", "inspect", "--format", "{{json .Endpoints.docker.Host}}"], { timeout: 5_000, maxBuffer: 64 * 1024, cwd: "/" });
      endpoint = JSON.parse(result.stdout.trim()) as string;
    }
    const client = new DockerClient(endpoint);
    if (!(await lstat(endpoint.slice(7))).isSocket()) throw new Error("Docker daemon is unavailable. Start the local Docker engine.");
    return client;
  }
  environment(): NodeJS.ProcessEnv {
    const env = { ...process.env }; delete env.DOCKER_CONTEXT; delete env.DOCKER_HOST;
    return env;
  }
  async run(args: readonly string[], timeout = 15_000): Promise<string> {
    try {
      const result = await execute("docker", ["--host", this.endpoint, ...args], { env: this.environment(), cwd: "/", timeout, maxBuffer: 16 * 1024 * 1024 });
      return result.stdout;
    } catch { throw new Error(`Docker ${args[0] ?? "operation"} failed or timed out. Check the local engine and approved image; host fallback is disabled.`); }
  }
  spawn(args: readonly string[]): ChildProcessWithoutNullStreams {
    return spawn("docker", ["--host", this.endpoint, ...args], { cwd: "/", env: this.environment(), stdio: ["pipe", "pipe", "pipe"] });
  }
}
export async function probeDocker(client?: DockerClient): Promise<{ available: boolean; blocker?: string; imageId?: string }> {
  try {
    client ??= await DockerClient.connect();
    const server = JSON.parse(await client.run(["info", "--format", "{{json .}}"], 5_000));
    if (server.OSType !== "linux" || !(server.SecurityOptions ?? []).some((s: string) => s.startsWith("name=seccomp"))) throw new Error("Docker requires Linux containers and an enabled seccomp profile.");
    let imageId: string | undefined;
    try {
      const image = JSON.parse(await client.run(["image", "inspect", DOCKER_IMAGE_TAG]))[0];
      if (image.Config?.Labels?.[DOCKER_IMAGE_LABEL] === "1" && /^sha256:[a-f0-9]{64}$/u.test(image.Id)) imageId = image.Id;
    } catch { /* Image provisioning is a separate reviewed operation. */ }
    return { available: true, imageId };
  } catch { return { available: false, blocker: "Local Docker with Linux containers and seccomp is unavailable. Start or repair Docker; Local host remains available." }; }
}
/** Called only by an approved setup apply operation; never during execution acquisition. */
export async function provisionDockerImage(): Promise<string> {
  const client = await DockerClient.connect();
  const context = fileURLToPath(new URL("../../workers", import.meta.url));
  await client.run(["build", "--pull", "--file", `${context}/docker/Dockerfile`, "--tag", DOCKER_IMAGE_TAG, context], 600_000);
  const imageId = (await probeDocker(client)).imageId;
  if (!imageId) throw new Error("Docker image preparation did not verify. Policy was not saved.");
  return imageId;
}
