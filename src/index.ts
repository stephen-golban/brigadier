/**
 * The package's public surface.
 *
 * `config`, `contracts`, `quota`, `worker`, and `worktree` re-export their own
 * curated barrels wholesale. `discovery` and `init` do not: their barrels also
 * carry wiring constants, low-level readers, and CLI internals that exist so
 * the units can test and compose themselves, and shipping those as package API
 * would freeze plumbing that has to stay free to change. Consumers who need one
 * import it from the owning module.
 *
 * `plan` and `routing` are curated for the same reason. The two entry points
 * (`validatePlan`, `route`), the vocabulary needed to call them and read their
 * results, and the competence data decision #7 promises will be auditable
 * (`COMPETENCE_TABLE`, `CompetenceRule`, `DIFFICULTY_FLOORS`) are API. The
 * scoring helpers behind that data — `scoreModelId`, `matchCompetenceRule`,
 * `UNRANKED_SCORE`, `UNRANKED_RATIONALE` — are not: they are how the router and
 * `init` share one ranking path, and freezing them would freeze the shape of
 * the table itself rather than its contents.
 *
 * `COMPETENCE_TABLE` is re-exported here from `./routing/index.js`, its home
 * since the matrix moved out of `init`. `./init/index.js` still re-exports it
 * so `init` compiles against one copy, but exporting it from both barrels here
 * would be an ambiguous re-export. The public name is unchanged either way.
 */

export * from "./config/index.js";
export * from "./contracts.js";
export type {
  CatalogParseResult,
  CatalogProbeResult,
  CommandResult,
  DiscoveredModel,
  DiscoveredVendor,
  Discoverer,
  DiscoveryReport,
  DiscoveryWarning,
  ExecutableResolver,
  RunCommand,
  VendorCatalogSource,
  VendorDiscovererOptions,
} from "./discovery/index.js";
export {
  CLAUDE_STATIC_MODELS,
  createDiscoverer,
  parseCodexCatalog,
  VendorDiscoverer,
} from "./discovery/index.js";
export type {
  Choice,
  DroppedVendor,
  InitOptions,
  InputStream,
  OutputStream,
  Proposal,
  RankedModel,
  UnusableModel,
  VendorProposal,
} from "./init/index.js";
export {
  proposeConfig,
  runInit,
  withDefaultModel,
  withDegradedRouting,
  withEffortCeiling,
  withSecretsConsent,
} from "./init/index.js";
export type {
  PlanIssue,
  PlanIssueCode,
  PlanValidation,
  PlanValidationOptions,
} from "./plan/index.js";
export { validatePlan } from "./plan/index.js";
export * from "./quota/index.js";
export type {
  CompetenceRule,
  RoutedWorker,
  RoutingDecision,
  RoutingFailureReason,
  RoutingInput,
  RoutingRejection,
  RoutingRequest,
  SliceDifficulty,
  SliceRequirements,
} from "./routing/index.js";
export { COMPETENCE_TABLE, DIFFICULTY_FLOORS, route } from "./routing/index.js";
export * from "./worker/index.js";
export * from "./worktree/index.js";
