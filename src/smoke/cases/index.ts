import { corrupt_skill_usage_case } from "./corrupt-skill-usage.js";
import { bundled_skill_sync_case } from "./bundled-skill-sync.js";
import { init_lifecycle_case } from "./init-lifecycle.js";
import { update_dry_run_case } from "./update-dry-run.js";
import { bare_launch_case } from "./bare-launch.js";
import { pack_lifecycle_case } from "./pack-lifecycle.js";
import { evolution_safety_case } from "./evolution-safety.js";
import { evolution_lifecycle_case } from "./evolution-lifecycle.js";
import { gateway_stop_case } from "./gateway-stop.js";

export const allSmokeCases = [
  corrupt_skill_usage_case,
  bundled_skill_sync_case,
  init_lifecycle_case,
  update_dry_run_case,
  bare_launch_case,
  pack_lifecycle_case,
  evolution_safety_case,
  evolution_lifecycle_case,
  gateway_stop_case
];
