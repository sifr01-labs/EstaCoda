import { legacy_monolith_case } from "./legacy-monolith.js";
import { corrupt_skill_usage_case } from "./corrupt-skill-usage.js";
import { bundled_skill_sync_case } from "./bundled-skill-sync.js";

export const allSmokeCases = [
  legacy_monolith_case,
  corrupt_skill_usage_case,
  bundled_skill_sync_case
];
