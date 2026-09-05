---
{
  "name": "api-integration",
  "description": "Connect an API to a destination system using machine-readable API descriptions when available, with separate protected credential transfer and read-back verification.",
  "version": "1.0.0",
  "category": "automation",
  "routing": {
    "labels": ["api.integration", "api.import"],
    "triggerPatterns": [
      { "type": "regex", "value": "\\b(?:connect|import|add|create|generate|transfer|configure|set\\s+up)\\b.{0,120}\\b(?:apis?|products?|openapi|swagger|specifications?|specs?|collections?)\\b.{0,120}\\b(?:postman(?:\\s+(?:workspaces?|collections?))?|api\\s+clients?|developer\\s+portals?|credentials?|keys?|openapi|swagger|specifications?|specs?)\\b" },
      { "type": "regex", "value": "\\b(?:postman(?:\\s+(?:workspaces?|collections?))?|api\\s+clients?|developer\\s+portals?)\\b.{0,120}\\b(?:connect|import|add|create|generate|transfer|configure|set\\s+up)\\b.{0,120}\\b(?:apis?|products?|openapi|swagger|specifications?|specs?|collections?|credentials?|keys?)\\b" }
    ],
    "negativePatterns": [
      { "type": "contains", "value": "build an api" },
      { "type": "contains", "value": "implement api endpoint" },
      { "type": "regex", "value": "\\b(?:build|implement|create|add|write)\\b.{0,80}\\bapi\\s+(?:endpoint|service|backend)\\b" },
      { "type": "regex", "value": "^(?!.*\\b(?:connect|import|add|create|generate|transfer|configure|set\\s+up)\\b).*\\b(?:what(?:'s|\\s+is)\\s+wrong|why|diagnose|debug|troubleshoot|error|issue|problem|failing|failed)\\b.{0,160}\\b(?:postman|collections?|workspaces?|api\\s+integration)\\b" },
      { "type": "regex", "value": "^(?:how\\s+(?:do|can|would|should)\\s+i|explain|describe|teach|tell\\s+me\\s+how|show\\s+me\\s+how|write\\s+documentation|document)\\b.{0,240}\\b(?:postman|apis?|openapi|swagger|collections?|workspaces?|api\\s+integration)\\b" },
      { "type": "regex", "value": "^(?!.*\\b(?:connect|import|add|create|generate|transfer|configure|set\\s+up)\\b).*\\b(?:explain|how\\s+(?:does|do)|what\\s+is|tell\\s+me\\s+about|review|write\\s+documentation|document)\\b.{0,160}\\b(?:postman|collections?|workspaces?|environments?|requests?)\\b" }
    ],
    "requiredToolsets": ["browser", "mcp"],
    "confirmation": "policy",
    "priority": 28
  },
  "requiredToolsets": ["browser", "mcp"],
  "optionalToolsets": ["web", "files"],
  "permissionExpectations": ["auto-read", "ask-before-write"],
  "playbook": [
    {
      "id": "discover-api-source",
      "description": "Inspect the current visible API product or documentation region. For a multi-product request, use browser.extract on the grounded list region to retain names and exact hrefs together before leaving it. Names are display labels, never URL templates. Prefer complete bounded discovery first, but an unavailable item must not prevent safe progress on grounded items; report it separately. When a Plan would help, use one item per product. When comprehensive API structure is needed, prefer a grounded machine-readable export over collecting endpoint pages.",
      "toolsets": ["browser", "web"]
    },
    {
      "id": "reconcile-destination",
      "description": "Before creating destination resources, inspect the requested destination and its existing resources using configured read tools. Match source resources to existing destination identities; do not assume that setup means recreate. Choose create, update, verify, or skip per item based on the user-requested outcome and observed differences. Reuse existing structure where appropriate, and consult specifications only as needed. A missing or incomplete read is not proof that the destination is empty. Keep ambiguous matches explicit and clarify only when a consequential destination choice cannot be grounded.",
      "toolsets": ["mcp"]
    },
    {
      "id": "import-description",
      "description": "Execute the reconciled action for one resource at a time and verify its effect before moving on. If an import or new resource is actually needed, use the governed download receipt and the destination connector's reviewed artifact argument without copying full content through model context; prefer native import/generation operations. Do not re-import merely to verify or correct an existing resource. Reuse retained complete receipts on retry; download again only when the artifact is stale, invalid, or unavailable. If no machine-readable description or reviewed import exists, extract only documentation needed for the requested integration. Preserve completed items and continue with unfinished ones after interruption.",
      "toolsets": ["browser", "mcp"]
    },
    {
      "id": "configure-protected-values",
      "description": "Transfer credentials separately through the protected-input path. Never place credential values inside API descriptions, collections, ordinary MCP arguments, or model-authored text. If credential labels or their authentication roles are unclear, clarify the labels together; never split, concatenate, or assign roles based on value length. Use the configured protected argument envelopes to collect values, not ordinary chat.",
      "toolsets": ["browser", "mcp"]
    },
    {
      "id": "verify-destination",
      "description": "Read back the destination's imported API resource and protected-value metadata using configured verification tools. Confirm names, references, and structure without requesting protected values again. In a multi-product request, treat only that verified product as complete and continue from the first unfinished product after interruption.",
      "toolsets": ["mcp"]
    }
  ],
  "evaluations": [
    {
      "input": "Set up these products in our Postman collection.",
      "expected": { "selectedSkill": "api-integration" },
      "shouldUseToolsets": ["browser", "mcp"],
      "expectedOutcome": "The API integration workflow is selected from the requested operation and Postman destination."
    },
    {
      "input": "Add these APIs to my Postman workspace.",
      "expected": { "selectedSkill": "api-integration" },
      "shouldUseToolsets": ["browser", "mcp"],
      "expectedOutcome": "The API integration workflow is selected from the requested operation and Postman destination."
    },
    {
      "input": "Import these products and configure their credentials.",
      "expected": { "selectedSkill": "api-integration" },
      "shouldUseToolsets": ["browser", "mcp"],
      "expectedOutcome": "The paired import and protected-credential configuration operation selects the integration workflow."
    },
    {
      "input": "Create Postman collections from the developer portal.",
      "expected": { "selectedSkill": "api-integration" },
      "shouldUseToolsets": ["browser", "mcp"],
      "expectedOutcome": "The API integration workflow is selected from the requested collection creation and source portal."
    },
    {
      "input": "Generate a collection from these Swagger files.",
      "expected": { "selectedSkill": "api-integration" },
      "shouldUseToolsets": ["browser", "mcp"],
      "expectedOutcome": "The API integration workflow is selected from collection generation and machine-readable API artifacts."
    },
    {
      "input": "Transfer these API specifications and keys into Postman.",
      "expected": { "selectedSkill": "api-integration" },
      "shouldUseToolsets": ["browser", "mcp"],
      "expectedOutcome": "The API integration workflow is selected while artifact and protected-value transfers remain separate."
    },
    {
      "input": "What is wrong with my Postman collection?",
      "expected": { "selectedSkill": null },
      "expectedOutcome": "A diagnostic question does not select the API transfer workflow merely because Postman is named."
    },
    {
      "input": "Explain how Postman environments work.",
      "expected": { "selectedSkill": null },
      "expectedOutcome": "An educational question does not select the API transfer workflow."
    },
    {
      "input": "Review this Postman request.",
      "expected": { "selectedSkill": null },
      "expectedOutcome": "A read-only review does not select the API transfer workflow."
    },
    {
      "input": "Build an API endpoint.",
      "expected": { "selectedSkill": null },
      "expectedOutcome": "API implementation remains outside the API transfer workflow."
    },
    {
      "input": "Write documentation about Postman.",
      "expected": { "selectedSkill": null },
      "expectedOutcome": "Documentation writing does not select the API transfer workflow."
    }
  ]
}
---

# API Integration

Prefer one comprehensive, visible machine-readable API description over page-by-page endpoint scraping when the task needs the full API structure.

Use the browser's current grounded controls and normal governed actions. A visible export is a useful option, not a mandatory workflow. If no suitable export is present, or the destination has no reviewed artifact-import argument, extract the smallest documentation set that can complete the user's request.

Keep the two data paths separate:

- API descriptions travel as session-owned governed artifacts through reviewed connector arguments.
- Credentials travel through protected input and must not enter the API artifact, model context, or ordinary connector arguments.

For a multi-product transfer, keep progress monotonic: retain the discovered product list, then download, import, and verify one product before starting the next. A complete governed receipt already contains the reference, filename, hash, and source origin needed for relay; reuse it unless the runtime rejects it. If work stops partway through, report the verified products and resume from the first unfinished product rather than repeating completed discovery or downloads.

After import or generation, use the destination connector's read tools to verify the resulting API resource, collection, environment, or equivalent state. Reuse fresh action receipts and confirmed reads instead of taking redundant snapshots or repeating unchanged connector queries.

An accepted asynchronous operation is not a completed resource. Retain its job/task ID together with the source resource ID and use the connector's status tool with a reasonable polling interval before retrying creation. Report pending, failed, and completed separately; an empty list proves neither job failure nor queue failure. If status inspection is unavailable, name that missing capability and continue independent items without claiming a cause. After completion, read back the actual destination resource. Historical checkpoint identifiers remain useful locators, not proof that a resource still exists or is correctly configured.
