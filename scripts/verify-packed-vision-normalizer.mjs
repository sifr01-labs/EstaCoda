import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const packageRoot = process.argv[2];
const expectedPlatform = process.argv[3];
const expectedArch = process.argv[4];
if (packageRoot === undefined || expectedPlatform === undefined || expectedArch === undefined) {
  throw new Error("usage: verify-packed-vision-normalizer.mjs <package-root> <platform> <arch>");
}
if (process.platform !== expectedPlatform || process.arch !== expectedArch) {
  throw new Error(
    `runner mismatch: expected ${expectedPlatform}/${expectedArch}, got ${process.platform}/${process.arch}`
  );
}

const packageJson = JSON.parse(await readFile(resolve(packageRoot, "package.json"), "utf8"));
for (const lifecycleScript of ["preinstall", "install", "postinstall"]) {
  if (packageJson.scripts?.[lifecycleScript] !== undefined) {
    throw new Error(`packed EstaCoda must not run a ${lifecycleScript} dependency installer`);
  }
}
if (typeof packageJson.dependencies?.sharp !== "string") {
  throw new Error("packed EstaCoda is missing the Sharp runtime dependency");
}

const normalizerModule = await import(pathToFileURL(
  resolve(packageRoot, "dist/vision/image-normalizer.js")
).href);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAADUlEQVQImWP4z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==",
  "base64"
);
const result = await normalizerModule.createVisionImageNormalizer().normalize({
  ok: true,
  canonicalPath: "/package-check/image.png",
  displayPath: "image.png",
  bytes: png,
  byteLength: png.byteLength,
  mimeType: "image/png"
});
if (!result.ok || result.width !== 1 || result.height !== 1 || result.metadataStripped !== true) {
  throw new Error(`packed vision normalizer failed: ${JSON.stringify(result)}`);
}
console.log(`Packed vision normalizer verified on ${process.platform}/${process.arch}.`);
