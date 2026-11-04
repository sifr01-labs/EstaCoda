Net revenue is 170. Saved and read back ledger-lab/result.json; the verifier passed with exit status 0. The ledger and verifier remained unchanged.

### Result
Path: `ledger-lab/result.json`

```json
{"netRevenue":170}
```

### Arithmetic
- Sales: `125 + 80 = 205`
- Refunds: `25 + 10 = 35`
- **Net revenue: `205 − 35 = 170`**

Independently inspected the ledger and verifier. Applied the required override to the skill’s outdated sum-all step: positive refunds reduce revenue. The calculation matches the verifier’s assertion.

### Verification
Executed:
```sh
node ledger-lab/verify.mjs
```

Actual output:
```text
Verified netRevenue=170; refunds reduce revenue.
```

**Actual exit status: `0`.**

Only `ledger-lab/result.json` was written. Before-and-after SHA-256 hashes matched for the ledger and verifier. No execution failures were observed.
