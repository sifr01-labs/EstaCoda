---
{
  "name": "api-integration",
  "description": "Connect an API to a destination system using machine-readable API descriptions when available, with separate protected credential transfer and read-back verification.",
  "version": "1.0.0",
  "category": "automation",
  "routing": {
    "labels": ["api.integration", "api.import"],
    "triggerPatterns": [
      { "type": "contains", "value": "connect api" },
      { "type": "contains", "value": "import api" },
      { "type": "contains", "value": "api integration" },
      { "type": "contains", "value": "import openapi" },
      { "type": "contains", "value": "connect openapi" },
      { "type": "contains", "value": "import swagger" },
      { "type": "contains", "value": "connect swagger" }
    ],
    "negativePatterns": [
      { "type": "contains", "value": "build an api" },
      { "type": "contains", "value": "implement api endpoint" }
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
      "input": "Connect the APIs shown in this developer portal to my configured API client and add the credentials.",
      "expected": { "selectedSkill": "api-integration" },
      "shouldUseToolsets": ["browser", "mcp"],
      "expectedOutcome": "The agent prefers visible machine-readable exports, uses governed artifact import when reviewed, transfers credentials separately, and verifies destination state."
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
