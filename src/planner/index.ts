/**
 * The planner unit's barrel.
 *
 * `parsePlannerReply` and `planPrompt` are exported from their modules rather
 * than promoted here for the same reason `parseFindings` is not in the
 * supervisor's barrel: both are this build's tolerance of one model's reply
 * format and one prompt's wording, and both have to stay free to change as the
 * vendors' output does. The unit's own tests import them directly.
 *
 * Nothing here reaches `src/index.ts`. The planner is `brigadier run`'s
 * plumbing, like `runCli` and `buildRunDependencies`, and freezing it as package
 * API would freeze a seam that exists to be reshaped.
 */

export type {
  Planner,
  PlannerIdentity,
  PlannerOutcome,
  PlannerRequest,
} from "./contracts.js";
export type { ModelPlannerOptions } from "./planner.js";
export { createModelPlanner } from "./planner.js";
