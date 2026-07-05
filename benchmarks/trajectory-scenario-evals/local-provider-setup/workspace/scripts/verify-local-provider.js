const assert = require("node:assert/strict");
const { readFileSync } = require("node:fs");

const config = JSON.parse(readFileSync("config/local-provider.json", "utf8"));

assert.equal(config.provider, "local-openai-compatible");
assert.equal(config.baseUrl, "http://127.0.0.1:11434/v1");
assert.equal(config.model, "qwen2.5-coder");
