The accepted worker audit reports net revenue of 170, a saved and read-back result.json, and verifier exit status 0. Sales total 205; refunds reduce revenue by 35.

### Accounting reconciliation

| Category | Calculation | Total |
|---|---|---:|
| Sales | 125 + 80 | 205 |
| Refunds | 25 + 10 | 35 |
| **Net revenue** | **205 − 35** | **170** |

The user’s accounting rules superseded the skill’s outdated instruction to sum all amount fields. Positive refunds represent money returned and must be subtracted. Adding every amount would produce **240**, overstating revenue by **70**.

### Result file

The accepted worker result reports a verified write and readback of `ledger-lab/result.json` containing:

```json
{
  "netRevenue": 170
}
```

### Verifier execution

The worker reports executing:

```sh
node ledger-lab/verify.mjs
```

Reported execution receipt:
- **Exit status:** `0`
- **Stdout:** `Verified netRevenue=170; refunds reduce revenue.`
- **Stderr:** No stderr was reported.
- **Failures:** No verification failure or corrective rerun was reported.

### Integrity and evidence limits

The worker reports matching before-and-after SHA-256 hashes for `ledger-lab/transactions.json` and `ledger-lab/verify.mjs`, with only `ledger-lab/result.json` written.

This synthesis relies on the **accepted durable worker result**, which records the write/readback and execution outcome. The underlying workspace tool receipts were not separately supplied to this synthesis step, and I did not independently rerun verification or modify any files.
