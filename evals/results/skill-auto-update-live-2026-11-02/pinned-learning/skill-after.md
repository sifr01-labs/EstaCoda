---
{"name":"stock-snapshot","description":"Build an inventory snapshot from an event export.","requiredToolsets":["files"],"optionalToolsets":["shell-readonly"],"routing":{"labels":["coding"],"triggerPatterns":[{"type":"contains","value":"stock-snapshot"}],"confirmation":"policy"},"playbook":[],"evaluations":[]}
---
Read the requested CSV inventory events (sku, revision, quantity, deleted). Keep the last row for each sku because exports arrive in chronological order. After selecting the last row, omit entries whose deleted value is true. Preserve zero and negative integer quantities. Write the requested JSON as {"stock":{<sku>:<quantity>}} with sku keys sorted alphabetically. Read back and verify the saved file before reporting completion.
