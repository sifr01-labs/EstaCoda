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
      "description": "Identify the requested products from the current visible source region and retain names and exact hrefs with browser.extract before leaving it. Names are not URL templates. Then reconcile the destination BEFORE downloading and importing every product. Reuse retained hrefs instead of repeatedly reopening the source list. An unavailable item must not prevent independent work, including protected credential setup. When a Plan helps, use one item per product and record reuse/update/create decisions and exact destination IDs; parallel steps may be in_progress.",
      "toolsets": ["browser", "web"]
    },
    {
      "id": "reconcile-destination",
      "description": "List the requested destination's existing resources, then read plausible matches by exact ID to inspect their contents. Listing a matching name is neither verification nor a reason to create another copy. Choose reuse, update, or create per product from observed differences and the user's request; retain that decision and destination ID before moving on. For duplicates, inspect candidates rather than creating yet another copy; clarify only a consequential unresolved choice. Incomplete or failed reads do not establish absence. This is task guidance, not a new approval requirement or a blocker for independent items.",
      "toolsets": ["mcp"]
    },
    {
      "id": "import-description",
      "description": "Execute the reconciled action for one resource at a time and verify its effect before moving on. If an import or new resource is actually needed, use the governed download receipt and the destination connector's reviewed artifact argument without copying full content through model context; prefer native import/generation operations. Do not re-import merely to verify or correct an existing resource. Reuse retained complete receipts on retry; download again only when the artifact is stale, invalid, or unavailable. If no machine-readable description or reviewed import exists, extract only documentation needed for the requested integration. Preserve completed items and continue with unfinished ones after interruption.",
      "toolsets": ["browser", "mcp"]
    },
    {
      "id": "configure-protected-values",
      "description": "Configure credentials independently once the destination and authentication roles are grounded; a blocked product download need not postpone this. Inspect existing environment metadata, preserve intended fields, and use the configured protected argument envelopes to request related user-supplied values together in one grouped write when supported. Never put secrets in API descriptions, collections, ordinary arguments, or chat. Clarify ambiguous labels together; never infer roles from value length. Read back redacted environment metadata; do not claim API authentication was tested merely because an environment exists.",
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

An accepted asynchronous operation is not a completed resource. Retain its job/task ID, originating resource type, and resource ID together; use returned polling coordinates, not the type of resource being generated. A returned `/specs/<id>/tasks/<task>` path describes a task on a specification, even when its output is a collection. Use the connector's registered status tool, not an arbitrary URL fetch. A 403 applies to that request: check coordinates before diagnosing account permissions. Report pending, failed, and completed separately; an empty list proves neither job failure nor queue failure. If status inspection is unavailable, continue independent work and use an available destination readback without guessing the cause. Historical identifiers are locators, not proof of current existence or correct configuration.

On a stale download target, no action was dispatched. Use the returned recovery snapshot or take a fresh snapshot in the intended tab; choose the export control and its new identity together. Never repeat old arguments or copy a new revision onto an old ref. If recovery remains unsuccessful, leave that product unfinished and proceed with independent destination or protected-input work. Keep the optional checklist current, but do not stop execution merely because a checklist update failed. The final response must distinguish reused, created, verified, pending, and blocked products, and report credential setup separately.
