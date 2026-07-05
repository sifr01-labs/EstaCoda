const assert = require("node:assert/strict");
const { subtotalWithTax } = require("../src/totals.js");

assert.equal(subtotalWithTax([10, 5], 0.1), 16.5);
assert.equal(subtotalWithTax([20], 0.25), 25);
