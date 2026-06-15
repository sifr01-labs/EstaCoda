# Browserbase API Notes

## What Was Verified

This note records the Browserbase REST API surface used by the low-level EstaCoda Browserbase client. It is an implementation note for browser backend work and is not user-facing setup documentation.

## Official Docs Source And Date Checked

Checked on 2026-06-07 against current Browserbase documentation:

- https://docs.browserbase.com/reference/api/create-a-session
- https://docs.browserbase.com/reference/api/get-a-session
- https://docs.browserbase.com/reference/api/update-a-session
- https://docs.browserbase.com/reference/api

## Session Create Endpoint

Current docs use:

```text
POST https://api.browserbase.com/v1/sessions
```

This differs from older examples that used `https://www.browserbase.com/v1/sessions`.

## Required Headers

```text
X-BB-API-Key: <api key>
Content-Type: application/json
```

Header casing is shown as `X-BB-API-Key` in the API reference. Browserbase examples also use lowercase in some JavaScript snippets; the TypeScript client sends `X-BB-API-Key`.

## Request Body Fields

The create-session body supports:

```ts
{
  projectId?: string;
  keepAlive?: boolean;
  proxies?: boolean | object[];
  extensionId?: string;
}
```

EstaCoda requires `projectId` in the local client options and sends it explicitly. The client API exposes `extension?: string` for a small local surface, then maps it to Browserbase's documented `extensionId` field.

Optional fields are omitted unless explicitly provided.

## Response Fields Used By EstaCoda

EstaCoda uses only:

```ts
{
  id: string;
  connectUrl: string;
}
```

The full raw response is retained on the returned client object for future diagnostics and compatibility work, but callers must not log it blindly.

## CDP/WebSocket URL Extraction Rule

Current docs name the browser WebSocket/CDP connection field:

```text
connectUrl
```

The client fails closed if `connectUrl` is missing, empty, or not a string. It does not guess alternate field names.

## Session Close Endpoint

Current docs do not use `DELETE /v1/sessions/{id}` for ordinary session close. They use:

```text
POST https://api.browserbase.com/v1/sessions/{id}
Content-Type: application/json

{ "status": "REQUEST_RELEASE" }
```

The response is `200` with a session object. The TypeScript client implements this documented close behavior.

## Error Handling Decisions

- Missing API key and missing project ID are rejected in the constructor.
- HTTP `401` and `403` throw authentication errors and are not retried.
- HTTP `429` and `5xx` are retried with bounded deterministic backoff.
- HTTP `400` and other non-retryable `4xx` responses are not retried.
- Malformed JSON throws a deterministic parse error.
- Missing session ID or missing `connectUrl` throws a deterministic validation error.
- Error messages do not include the API key or response body.
- A `404` during close is treated as a non-success error unless future docs explicitly describe it as already closed.

## Known Deviations Or Uncertainties

- The task prompt mentioned `https://www.browserbase.com/v1/sessions` and `DELETE /v1/sessions/{id}`. Current official docs instead use `https://api.browserbase.com` and `POST /v1/sessions/{id}` with `status: "REQUEST_RELEASE"` to close a session.
- The client implements `getSession()` because current docs include `GET /v1/sessions/{id}`.

## Implementation Notes For The TypeScript Client

- Keep the client low-level and side-effect free until a method is called.
- Do not wire Browserbase into backend routing in this commit.
- Do not enforce cloud spend approval here; backend integration owns that policy.
- Inject `fetch` and retry delay in tests so no real network or real sleep is required.
