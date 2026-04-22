---
{
  "name": "youtube-knowledge-base",
  "description": "Extract video content and build a reusable knowledge base from a YouTube URL.",
  "version": "0.1.0",
  "whenToUse": [
    "The user sends a YouTube URL and asks to summarize, archive, extract, or build a knowledge base.",
    "The user asks to capture everything discussed in a video.",
    "The user asks for notes, claims, sources, or a durable knowledge file from a video."
  ],
  "requiredToolsets": ["web", "browser", "files", "research"],
  "workflow": [
    {
      "id": "extract-transcript",
      "description": "Try the fastest transcript/content extraction route.",
      "toolsets": ["web"],
      "fallbackTo": ["browser-route"]
    },
    {
      "id": "browser-route",
      "description": "Use browser navigation or alternate frontends if the transcript path is blocked.",
      "toolsets": ["browser"],
      "fallbackTo": ["ask-for-access"]
    },
    {
      "id": "structure-knowledge",
      "description": "Convert extracted content into durable notes with sections, claims, and follow-ups.",
      "toolsets": ["research", "files"]
    },
    {
      "id": "evaluate-output",
      "description": "Check that the resulting knowledge base answers the user's requested scope.",
      "toolsets": ["research"]
    }
  ],
  "permissionExpectations": ["auto-read", "ask-before-write"],
  "examples": [
    "Build a knowledge base from this YouTube video.",
    "Can you capture everything discussed here?",
    "Turn this video into durable notes."
  ],
  "evaluations": [
    {
      "input": "https://www.youtube.com/watch?v=abc123 build a knowledge base",
      "shouldUseToolsets": ["web", "browser", "research"],
      "shouldNotAskUserFirst": true,
      "expectedOutcome": "The agent extracts content, falls back when blocked, and produces structured notes."
    }
  ]
}
---

# YouTube Knowledge Base

Use this skill when the user wants durable understanding from a YouTube video or similar video source.

Default behavior:

- Do not ask the user what to do first if the request is clear.
- Try transcript extraction before heavier browser routes.
- If transcript access is blocked, try browser or alternate frontend routes.
- Structure the result into durable notes, claims, timestamps if available, open questions, and follow-up tasks.
- Ask only after safe extraction routes fail or if writing to a specific destination changes user state.

