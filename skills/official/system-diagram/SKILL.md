---
{
  "name": "system-diagram",
  "description": "Create dark-themed SVG system, cloud, infrastructure, and architecture diagrams as standalone HTML files.",
  "version": "1.0.0",
  "category": "visualization",
  "platforms": [
    "linux",
    "macos",
    "windows"
  ],
  "routing": {
    "labels": [
      "diagram.creation",
      "system.visualization",
      "architecture.visualization"
    ],
    "triggerPatterns": [
      {
        "type": "contains",
        "value": "system diagram"
      },
      {
        "type": "contains",
        "value": "architecture diagram"
      },
      {
        "type": "contains",
        "value": "cloud diagram"
      },
      {
        "type": "contains",
        "value": "infra diagram"
      }
    ],
    "negativePatterns": [
      {
        "type": "contains",
        "value": "floor plan"
      },
      {
        "type": "contains",
        "value": "biology diagram"
      }
    ],
    "requiredToolsets": [
      "files"
    ],
    "confirmation": "policy"
  },
  "requiredToolsets": [
    "files"
  ],
  "optionalToolsets": [
    "browser",
    "coding"
  ],
  "permissionExpectations": [
    "auto-read",
    "ask-before-write"
  ],
  "playbook": [
    {
      "id": "clarify-architecture",
      "description": "Identify components, boundaries, data flows, and intended audience.",
      "toolsets": [
        "core"
      ]
    },
    {
      "id": "generate-html",
      "description": "Create a self-contained HTML file with inline SVG and CSS.",
      "toolsets": [
        "files"
      ],
      "outputTarget": "workspace HTML file"
    },
    {
      "id": "verify-render",
      "description": "Preview in the Browser when available and fix layout issues before delivery.",
      "toolsets": [
        "browser"
      ],
      "fallbackTo": [
        "manual file path review"
      ]
    }
  ],
  "evaluations": [
    {
      "input": "Create an architecture diagram for a web app with React, API, Redis, Postgres, and S3.",
      "shouldUseToolsets": [
        "files"
      ],
      "shouldNotAskUserFirst": false
    }
  ]
}
---

# System Diagram

Generate professional, dark-themed technical architecture diagrams as standalone HTML files with inline SVG graphics. No API keys or rendering libraries are required. Write the HTML file in the workspace and preview it with the Browser tool when available.

## Scope

**Best suited for:**
- Software system architecture (frontend / backend / database layers)
- Cloud infrastructure (VPC, regions, subnets, managed services)
- Microservice / service-mesh topology
- Database + API map, deployment diagrams
- Anything with a tech-infra subject that fits a dark, grid-backed aesthetic

**Look elsewhere first for:**
- Physics, chemistry, math, biology, or other scientific subjects
- Physical objects (vehicles, hardware, anatomy, cross-sections)
- Floor plans, narrative journeys, educational / textbook-style visuals
- Hand-drawn whiteboard sketches
- Animated explainers (consider an animation skill)

If a more specialized skill is available for the subject, prefer that. If none fits, this skill can also serve as a general SVG diagram fallback — the output will just carry the dark tech aesthetic described below.

Based on [Cocoon AI's system-diagram-generator](https://github.com/Cocoon-AI/system-diagram-generator) (MIT).

## Workflow

1. User describes their system architecture (components, connections, technologies)
2. Generate the HTML file following the design system below
3. Save with `file.write` to a workspace `.html` file (for example `./system-diagram.html`)
4. Preview with the Browser tool when available; otherwise provide the workspace file path. The file works offline.

### Output Location

Save diagrams to a user-specified path, or default to the current working directory:
```
./[project-name]-architecture.html
```

### Preview

After saving, preview the workspace HTML file with EstaCoda's Browser tool when available. If Browser is not available, report the exact workspace path so the user can open it manually.

## Design System & Visual Language

### Color Palette (Semantic Mapping)

Use specific `rgba` fills and hex strokes to categorize components:

| Component Type | Fill (rgba) | Stroke (Hex) |
| :--- | :--- | :--- |
| **Frontend** | `rgba(8, 51, 68, 0.4)` | `#22d3ee` (cyan-400) |
| **Backend** | `rgba(6, 78, 59, 0.4)` | `#34d399` (emerald-400) |
| **Database** | `rgba(76, 29, 149, 0.4)` | `#a78bfa` (violet-400) |
| **AWS/Cloud** | `rgba(120, 53, 15, 0.3)` | `#fbbf24` (amber-400) |
| **Security** | `rgba(136, 19, 55, 0.4)` | `#fb7185` (rose-400) |
| **Message Bus** | `rgba(251, 146, 60, 0.3)` | `#fb923c` (orange-400) |
| **External** | `rgba(30, 41, 59, 0.5)` | `#94a3b8` (slate-400) |

### Typography & Background
- **Font:** JetBrains Mono (Monospace), loaded from Google Fonts
- **Sizes:** 12px (Names), 9px (Sublabels), 8px (Annotations), 7px (Tiny labels)
- **Background:** Slate-950 (`#020617`) with a subtle 40px grid pattern

```svg
<!-- Background Grid Pattern -->
<pattern id="grid" width="40" height="40" patternUnits="userSpaceOnUse">
  <path d="M 40 0 L 0 0 0 40" fill="none" stroke="#1e293b" stroke-width="0.5"/>
</pattern>
```

## Technical Implementation Details

### Component Rendering
Components are rounded rectangles (`rx="6"`) with 1.5px strokes. To prevent arrows from showing through semi-transparent fills, use a **double-rect masking technique**:
1. Draw an opaque background rect (`#0f172a`)
2. Draw the semi-transparent styled rect on top

### Connection Rules
- **Z-Order:** Draw arrows *early* in the SVG (after the grid) so they render behind component boxes
- **Arrowheads:** Defined via SVG markers
- **Security Flows:** Use dashed lines in rose color (`#fb7185`)
- **Boundaries:**
  - *Security Groups:* Dashed (`4,4`), rose color
  - *Regions:* Large dashed (`8,4`), amber color, `rx="12"`

### Spacing & Layout Logic
- **Standard Height:** 60px (Services); 80-120px (Large components)
- **Vertical Gap:** Minimum 40px between components
- **Message Buses:** Must be placed *in the gap* between services, not overlapping them
- **Legend Placement:** **CRITICAL.** Must be placed outside all boundary boxes. Calculate the lowest Y-coordinate of all boundaries and place the legend at least 20px below it.

## Document Structure

The generated HTML file follows a four-part layout:
1. **Header:** Title with a pulsing dot indicator and subtitle
2. **Main SVG:** The diagram contained within a rounded border card
3. **Summary Cards:** A grid of three cards below the diagram for high-level details
4. **Footer:** Minimal metadata

### Info Card Pattern
```html
<div class="card">
  <div class="card-header">
    <div class="card-dot cyan"></div>
    <h3>Title</h3>
  </div>
  <ul>
    <li>• Item one</li>
    <li>• Item two</li>
  </ul>
</div>
```

## Output Requirements
- **Single File:** One self-contained `.html` file
- **No External Dependencies:** All CSS and SVG must be inline (except Google Fonts)
- **No JavaScript:** Use pure CSS for any animations (like pulsing dots)
- **Compatibility:** Must render correctly in any modern web browser

## Template Reference

Load the full HTML template for the exact structure, CSS, and SVG component examples:

```
Read `templates/template.html` from this skill only when a concrete starter file is useful.
```

The template contains working examples of every component type (frontend, backend, database, cloud, security), arrow styles (standard, dashed, curved), security groups, region boundaries, and the legend — use it as your structural reference when generating diagrams.
