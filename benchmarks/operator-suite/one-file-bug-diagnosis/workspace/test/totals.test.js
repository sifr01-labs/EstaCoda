import assert from "node:assert/strict";
import { totalWithTax } from "../src/totals.js";

const items = [{ price: 40 }, { price: 60 }];
assert.equal(totalWithTax(items, 0.08), 108);
