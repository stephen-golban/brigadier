/**
 * The routing unit's barrel. The engine is `route`; everything else here is
 * either the vocabulary a caller needs to describe a slice to it, or the
 * competence matrix, which is exported so it can be read, printed, and argued
 * with rather than being a private constant no user can audit.
 */

export type { CompetenceRule } from "./competence.js";
export {
  COMPETENCE_TABLE,
  DIFFICULTY_FLOORS,
  matchCompetenceRule,
  scoreModelId,
  UNRANKED_RATIONALE,
  UNRANKED_SCORE,
} from "./competence.js";
export type {
  ExcludedModel,
  RoutedWorker,
  RoutingDecision,
  RoutingFailureReason,
  RoutingInput,
  RoutingRejection,
  RoutingRequest,
  SliceDifficulty,
  SliceRequirements,
} from "./contracts.js";
export { route } from "./router.js";
