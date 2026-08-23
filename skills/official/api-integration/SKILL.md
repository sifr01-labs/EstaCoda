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
      "description": "Inspect the current visible API product or documentation region. When a grounded OpenAPI, Swagger, AsyncAPI, RAML, GraphQL, protobuf, Smithy, or equivalent export is available and comprehensive structure is needed, prefer browser.download over manually collecting endpoint pages. This is a preference, not a forced action.",
      "toolsets": ["browser", "web"]
    },
    {
      "id": "import-description",
      "description": "Use the governed download receipt and a destination connector's reviewed artifact argument to import the machine-readable description without copying its full content through model context. Prefer the destination's native spec-import or collection-generation operation. If no machine-readable description or reviewed import exists, extract only the documentation needed for the requested integration.",
      "toolsets": ["browser", "mcp"]
    },
    {
      "id": "configure-protected-values",
      "description": "Transfer credentials separately through the protected-input path. Never place credential values inside API descriptions, collections, ordinary MCP arguments, or model-authored text.",
      "toolsets": ["browser", "mcp"]
    },
    {
      "id": "verify-destination",
      "description": "Read back the destination's imported API resource and protected-value metadata using configured verification tools. Confirm names, references, and structure without requesting protected values again.",
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

After import or generation, use the destination connector's read tools to verify the resulting API resource, collection, environment, or equivalent state. Reuse fresh action receipts and confirmed reads instead of taking redundant snapshots or repeating unchanged connector queries.
