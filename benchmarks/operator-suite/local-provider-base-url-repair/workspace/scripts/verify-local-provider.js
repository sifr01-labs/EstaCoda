import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(process.argv[2], "utf8"));
assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
assert.equal(config.provider, "local-openai");
