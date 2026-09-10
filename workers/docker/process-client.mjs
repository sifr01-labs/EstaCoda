// Trusted local transport only. User programs are handed to a verified container.
const { DockerContainer } = await import(process.argv[2]);
const { DockerClient } = await import(process.argv[3]);

function packet() {
  return new Promise((resolve, reject) => {
    let bytes = Buffer.alloc(0);
    const read = (chunk) => {
      bytes = Buffer.concat([bytes, chunk]);
      if (bytes.length > 1024 * 1024) { process.stdin.off("data", read); reject(new Error("Command packet exceeds limit")); return; }
      const end = bytes.indexOf(10);
      if (end < 0) return;
      process.stdin.pause(); process.stdin.off("data", read);
      if (bytes.length > end + 1) process.stdin.unshift(bytes.subarray(end + 1));
      try { resolve(JSON.parse(bytes.subarray(0, end))); } catch (error) { reject(error); }
    };
    process.stdin.on("data", read);
    process.stdin.once("end", () => reject(new Error("Command packet missing")));
    process.stdin.once("error", reject);
  });
}
let container, stopping, preparing;
let requestedStop;
const finish = (code) => stopping ??= (async () => {
  try { await preparing?.catch(() => {}); await container?.release(); process.exit(code); }
  catch { process.stderr.write("Owned Docker cleanup is uncertain.\n"); process.exit(125); }
})();
process.on("SIGTERM", () => { requestedStop = 143; void finish(143); });
process.on("SIGINT", () => { requestedStop = 130; void finish(130); });
try {
  const input = await packet();
  const client = new DockerClient(input.endpoint);
  preparing = DockerContainer.prepare({ client, profileId: input.profileId, workspaceRoot: input.workspaceRoot, homeDir: input.homeDir, policy: input.policy, receipt: input.receipt }).then((value) => { container = value; });
  await preparing;
  if (requestedStop) await finish(requestedStop);
  const bootstrap = `import os,json
b=bytearray()
while True:
 c=os.read(0,1)
 if c==b"\\n": break
 if not c or len(b)>1048576: raise ValueError("invalid command packet")
 b.extend(c)
p=json.loads(b)
os.execvpe(p["command"],p["args"],p["env"])
`;
  const child = client.spawn(["exec", "-i", "--user", container.user, container.id, "python3", "-u", "-c", bootstrap]);
  let total = 0;
  const output = (target) => (chunk) => {
    const remaining = Math.max(0, container.facts.limits.outputBytes - total);
    total += chunk.length;
    if (remaining) target.write(chunk.subarray(0, remaining));
    if (total > container.facts.limits.outputBytes) void finish(124);
  };
  child.stdout.on("data", output(process.stdout)); child.stderr.on("data", output(process.stderr));
  child.once("error", () => { void finish(125); });
  child.once("close", (code) => { void finish(code ?? 125); });
  child.stdin.on("error", () => {});
  child.stdin.write(JSON.stringify({ command: input.command, args: [input.command, ...input.args], env: input.env }) + "\n");
  process.stdin.pipe(child.stdin);
  setTimeout(() => { void finish(124); }, container.facts.limits.timeoutMs).unref();
} catch { process.stderr.write("Docker command preparation or transport failed; no host fallback.\n"); await finish(125); }
