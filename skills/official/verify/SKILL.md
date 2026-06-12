---
{
  "name": "verify",
  "description": "Verify a code change does what it should by running the app.",
  "version": "1.0.0",
  "category": "software-development",
  "routing": {
    "labels": ["verification", "testing", "e2e-verify"],
    "triggerPatterns": [
      { "type": "contains", "value": "/verify" },
      { "type": "contains", "value": "test my change" },
      { "type": "contains", "value": "did this work" },
      { "type": "contains", "value": "check if it runs" },
      { "type": "contains", "value": "run the tests" },
      { "type": "contains", "value": "does it still work" }
    ],
    "negativePatterns": [
      { "type": "contains", "value": "verify identity" },
      { "type": "contains", "value": "verify password" },
      { "type": "contains", "value": "verify email" },
      { "type": "contains", "value": "verify account" },
      { "type": "contains", "value": "verify phone" }
    ],
    "requiredToolsets": ["files", "shell-write", "browser"],
    "confirmation": "policy",
    "priority": 25
  },
  "intentLabels": ["verification", "testing"],
  "triggerPatterns": ["/verify", "test my change", "did this work", "check if it runs", "run the tests", "does it still work"],
  "negativePatterns": ["verify identity", "verify password", "verify email", "verify account", "verify phone"],
  "whenToUse": [
    "The user invokes /verify.",
    "The user asks to verify, test, or check if a code change works.",
    "The user wants to run the app or tests after making changes."
  ],
  "requiredToolsets": ["files", "shell-write", "browser"],
  "optionalToolsets": ["web", "shell-readonly"],
  "playbook": [
    {
      "id": "identify-target",
      "description": "Determine whether the project is a CLI app, server, library, or UI. Look at package.json, Cargo.toml, pyproject.toml, or similar project files. Ask the user if ambiguous.",
      "toolsets": ["files"],
      "successCriteria": ["The project type and verification target are identified."]
    },
    {
      "id": "run-verification",
      "description": "Execute the appropriate verification steps: unit tests, build, start server, run CLI, or open browser. Use the references/ examples for CLI and server patterns.",
      "toolsets": ["shell-write", "browser"],
      "preferredTool": "terminal.run",
      "fallbackTo": ["browser.navigate"],
      "successCriteria": ["Verification steps executed and results captured."]
    },
    {
      "id": "report-results",
      "description": "Report what was verified, what passed, what failed, and any next steps.",
      "toolsets": ["files"],
      "successCriteria": ["User receives a clear pass/fail report with actionable next steps."]
    }
  ],
  "permissionExpectations": ["auto-read", "ask-before-write"],
  "examples": [
    "/verify",
    "Did my change break anything?",
    "Run the tests.",
    "Verify the server still starts."
  ],
  "evaluations": [
    {
      "input": "/verify",
      "shouldUseToolsets": ["files", "shell-write", "browser"],
      "shouldNotAskUserFirst": true,
      "expectedOutcome": "The agent identifies the project type, runs appropriate verification (tests, build, server, CLI, or browser), and reports results."
    }
  ]
}
---

# Verify

Verify a code change does what it should by running the app.

## Approach

1. **Identify the project type.** Look at the project configuration to determine if this is a CLI tool, a server, a library, or a UI application.
2. **Run the appropriate verification.** Use the references below for common patterns.
3. **Report results clearly.** Pass/fail with actionable next steps.

## CLI Verification

For command-line tools:

1. Build if needed (check package.json, Makefile, or build scripts).
2. Run the CLI with typical arguments.
3. Check exit code and output.
4. Run any unit tests.

See `references/cli.md` for detailed CLI verification patterns.

## Server Verification

For web/API servers:

1. Start the server (check package.json scripts, Makefile, or docker-compose).
2. Wait for the port to be ready.
3. Hit a health or smoke endpoint with curl or the browser tool.
4. Check logs for errors.
5. Stop the server cleanly.

See `references/server.md` for detailed server verification patterns.

## Library Verification

For libraries/packages:

1. Run the test suite.
2. Run the type checker.
3. Run the linter.
4. If applicable, build the package and check for warnings.

## UI/Application Verification

For UI applications:

1. Start the dev server or build the app.
2. Use browser tools to navigate to the relevant page.
3. Interact with changed elements.
4. Verify expected behavior visually or via console.

## Rules

- Do not claim verification passed unless you actually ran the verification and saw the expected result.
- If tests fail, show the relevant failure output and suggest fixes.
- If the server fails to start, capture the error logs.
- Always clean up: stop dev servers, remove temporary files.
