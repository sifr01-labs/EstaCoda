import { corrupt_skill_usage_case } from "./corrupt-skill-usage.js";
import { bundled_skill_sync_case } from "./bundled-skill-sync.js";
import { state_bootstrap_case } from "./state-bootstrap.js";
import { update_dry_run_case } from "./update-dry-run.js";
import { bare_launch_case } from "./bare-launch.js";
import { pack_lifecycle_case } from "./pack-lifecycle.js";
import { evolution_safety_case } from "./evolution-safety.js";
import { evolution_lifecycle_case } from "./evolution-lifecycle.js";
import { gateway_stop_case } from "./gateway-stop.js";
import { whatsapp_support_case } from "./whatsapp-support.js";
import { delegation_mvp_case } from "./delegation-mvp.js";
import { provider_setup_endpoint_first_case } from "./provider-setup-endpoint-first.js";

export const allSmokeCases = [
  corrupt_skill_usage_case,
  bundled_skill_sync_case,
  state_bootstrap_case,
  update_dry_run_case,
  bare_launch_case,
  pack_lifecycle_case,
  evolution_safety_case,
  evolution_lifecycle_case,
  gateway_stop_case,
  whatsapp_support_case,
  delegation_mvp_case,
  provider_setup_endpoint_first_case
];
