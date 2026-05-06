import { legacy_monolith_case } from "./legacy-monolith.js";
import { corrupt_skill_usage_case } from "./corrupt-skill-usage.js";
import { bundled_skill_sync_case } from "./bundled-skill-sync.js";
import { init_lifecycle_case } from "./init-lifecycle.js";
import { update_dry_run_case } from "./update-dry-run.js";
import { bare_launch_case } from "./bare-launch.js";
import { skills_pack_lifecycle_case } from "./skills-pack-lifecycle.js";
import { evolution_safety_case } from "./evolution-safety.js";
import { evolution_lifecycle_case } from "./evolution-lifecycle.js";

export const allSmokeCases = [
  legacy_monolith_case,
  corrupt_skill_usage_case,
  bundled_skill_sync_case,
  init_lifecycle_case,
  update_dry_run_case,
  bare_launch_case,
  skills_pack_lifecycle_case,
  evolution_safety_case,
  evolution_lifecycle_case
];
