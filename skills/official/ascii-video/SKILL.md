---
{
  "name": "ascii-video",
  "description": "Create ASCII art videos, animated logo treatments, and generative terminal-style motion pieces.",
  "version": "0.1.0",
  "category": "media",
  "whenToUse": [
    "The user invokes /ascii-video.",
    "The user asks for an ASCII art animation, ASCII video, logo animation, or terminal-style motion piece.",
    "The user wants a generated video artifact based on source imagery, logos, text, or pure generative motion."
  ],
  "requiredToolsets": ["media", "files", "shell-write", "web", "browser", "research"],
  "workflow": [
    {
      "id": "clarify-brief",
      "description": "Confirm only the missing creative constraints: source/generative mode, duration, style, aspect ratio, and output target.",
      "toolsets": ["research"],
      "successCriteria": ["creative brief is specific enough to render without repeated questions"]
    },
    {
      "id": "collect-assets",
      "description": "Fetch or locate source logos, videos, images, audio, or text inputs needed for the animation.",
      "toolsets": ["web", "browser", "files"],
      "fallbackTo": ["generate-assets"],
      "successCriteria": ["source assets are available as local workspace files"],
      "outputTarget": ".estacoda/artifacts"
    },
    {
      "id": "generate-assets",
      "description": "Create placeholder/generated visual inputs when source assets are unavailable or the user requested a generative piece.",
      "toolsets": ["files", "shell-write", "media"],
      "successCriteria": ["the workflow has enough local assets to render"]
    },
    {
      "id": "render-video",
      "description": "Write and run the generator/render pipeline, patching failures until a video artifact exists.",
      "toolsets": ["files", "shell-write", "media"],
      "preferredTool": "terminal.run",
      "successCriteria": ["final video file exists", "duration and dimensions match the brief"],
      "outputTarget": ".estacoda/artifacts"
    },
    {
      "id": "preview-frame",
      "description": "Extract a representative preview frame and inspect the final artifact metadata.",
      "toolsets": ["media"],
      "preferredTool": "media.extract-frame",
      "fallbackTo": ["record-artifact"],
      "successCriteria": ["preview frame is available or preview limitation is clearly reported"]
    },
    {
      "id": "record-artifact",
      "description": "Record final video and preview outputs as artifacts with a concise delivery summary.",
      "toolsets": ["media", "files"],
      "preferredTool": "artifact.record",
      "successCriteria": ["final artifact path and specs are ready for the user"]
    }
  ],
  "permissionExpectations": ["auto-read", "ask-before-write"],
  "examples": [
    "/ascii-video make a 10s generative logo animation",
    "Turn this logo into an ASCII art video.",
    "Create an audio-reactive ASCII animation from this clip."
  ],
  "evaluations": [
    {
      "input": "/ascii-video make a 10 second generative logo animation",
      "shouldUseToolsets": ["media", "files", "shell-write"],
      "shouldNotAskUserFirst": true,
      "expectedOutcome": "The agent clarifies only missing creative constraints, renders or attempts a video artifact, extracts a preview, and records the artifact."
    }
  ]
}
---

# ASCII Video

Use this skill when the user wants a finished ASCII animation or video artifact.

Default behavior:

- Be creative and production-minded, not just explanatory.
- Ask at most one brief clarification round when the creative brief is underspecified.
- Prefer generating a concrete local artifact over describing how the user could generate it.
- Use local assets when provided; otherwise fetch public assets or create generative placeholders.
- Render, observe errors, patch the generator, and retry until the artifact exists or a real blocker is reached.
- Extract a preview frame when possible.
- Final response should include artifact path, specs, what was created, and useful next improvements.

Do not claim the video was created unless the artifact exists locally.
