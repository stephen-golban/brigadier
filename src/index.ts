/**
 * The package's public surface.
 *
 * `config`, `contracts`, `quota`, `worker`, and `worktree` re-export their own
 * curated barrels wholesale. `discovery` and `init` do not: their barrels also
 * carry wiring constants, low-level readers, and CLI internals that exist so
 * the units can test and compose themselves, and shipping those as package API
 * would freeze plumbing that has to stay free to change. Consumers who need one
 * import it from the owning module.
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
  CompetenceRule,
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
  COMPETENCE_TABLE,
  proposeConfig,
  runInit,
  withDefaultModel,
  withEffortCeiling,
  withQuotaFallback,
  withSecretsConsent,
} from "./init/index.js";
export * from "./quota/index.js";
export * from "./worker/index.js";
export * from "./worktree/index.js";
