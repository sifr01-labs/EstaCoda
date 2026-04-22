---
{
  "name": "telegram-media-analysis",
  "description": "Analyze media sent through a channel without asking the user for a local file path.",
  "version": "0.1.0",
  "whenToUse": [
    "The user references an image, PDF, audio, video, or document sent through Telegram or another channel.",
    "The user says they sent a file in chat and asks the agent to inspect it."
  ],
  "requiredToolsets": ["telegram", "media", "files"],
  "workflow": [
    {
      "id": "resolve-channel-media",
      "description": "Find and download the referenced channel attachment into local media storage.",
      "toolsets": ["telegram", "media"]
    },
    {
      "id": "inspect-media",
      "description": "Inspect the media with the best available file, OCR, vision, or document tool.",
      "toolsets": ["media", "files"]
    },
    {
      "id": "reply-active-channel",
      "description": "Reply to the active channel with the result.",
      "toolsets": ["telegram"]
    }
  ],
  "permissionExpectations": ["auto-read", "auto-active-channel-reply"],
  "examples": [
    "I sent the image on Telegram. Can you analyze it?",
    "Look at the PDF I uploaded here.",
    "What is in the voice note I sent?"
  ],
  "evaluations": [
    {
      "input": "I sent it in Telegram chat, can you not see it?",
      "shouldUseToolsets": ["telegram", "media"],
      "shouldNotAskUserFirst": true,
      "expectedOutcome": "The agent resolves the uploaded media instead of asking for a filesystem path."
    }
  ]
}
---

# Telegram Media Analysis

Use this skill when the user references media sent through Telegram or another channel.

Default behavior:

- Do not ask the user for a local file path when the media came through the active channel.
- Resolve the channel attachment through the channel adapter.
- Download or reference the media in local storage.
- Use the best available media/document inspection path.
- Reply to the same active channel unless the user asks for a different destination.

