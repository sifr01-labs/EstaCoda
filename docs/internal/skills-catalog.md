# Skills Catalog

The skills catalog is a generated static data layer for public documentation and other read-only consumers. EstaCoda owns the source skill files and generates JSON from them; the Docusaurus site only serves the generated files as static JSON.

This repo does not implement the public skills UI. Do not add a `/skills` page or React UI here as part of catalog maintenance.

## Source Skills

Source skills live under:

```text
skills/official/<skill-name>/SKILL.md
```

The source registry lives at:

```text
registries/skills.sources.json
```

Only local sources are supported for now. The initial registry points at `skills/official` with `sourceType` set to `official`.

## Adding A Skill

Add a new folder under `skills/official/` and create a `SKILL.md` file. The folder name becomes the public slug. The generated public id is:

```text
<sourceType>.<slug>
```

For official skills this looks like:

```text
official.ascii-video
```

The display name comes from frontmatter `name`; it does not need to match the folder slug.

## Required Frontmatter

`SKILL.md` must start with JSON frontmatter between the first two `---` delimiters. This is JSON, not YAML, and it is parsed with `JSON.parse`.

Required fields:

```json
{
  "name": "Display Name",
  "description": "Short public description.",
  "routing": {
    "labels": ["example-label"],
    "triggerPatterns": [{ "type": "contains", "value": "example" }],
    "confirmation": "policy"
  },
  "requiredToolsets": ["files"],
  "optionalToolsets": [],
  "playbook": [],
  "evaluations": []
}
```

`optionalToolsets` and `routing.triggerPatterns` may be omitted, but the generator will warn. Unknown toolset names and unknown additional frontmatter fields are allowed. The scanner does not import runtime agent code to validate toolsets.

The first meaningful Markdown paragraph after the frontmatter becomes the public `overview`.

## Regenerating

Run:

```bash
pnpm run skills:catalog
```

This writes:

```text
website/static/api/skills.json
website/static/api/skills-meta.json
```

Docusaurus serves `website/static/` under the docs base path, so after docs build/deploy these are expected at:

```text
/docs/api/skills.json
/docs/api/skills-meta.json
```

The script is standalone for now. It is not wired into `prebuild`, because the package build and release flow should remain unchanged unless maintainers intentionally add catalog generation to that path.
