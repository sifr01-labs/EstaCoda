import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const log = readFileSync(process.argv[2], "utf8");
assert.match(log, /recovered after injected terminal failure/u);
