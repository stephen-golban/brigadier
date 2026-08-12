# Changelog

All notable changes to this project are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

No unreleased changes.

## [0.1.1] - 2026-08-12

### Changed

- The release build now signs the disk image before notarizing it, and
  assembly is gated on a notarized binary — a build no longer produces a
  distributable artifact from an unnotarized one.

## [0.1.0] - 2026-08-11

Initial release.

### Added

- The supervisor: decomposes a task into slices, routes each to a model,
  gives it its own git worktree, and spawns the vendor CLI already installed
  and logged in on the machine.
- Four commands: `brigadier init` (probe, propose, confirm, write config),
  `brigadier run` (plan and execute, or execute an existing plan),
  `brigadier install` (write host-side doctrine into `claude-code`, `codex`,
  `opencode`, or stage an MCP bundle for `claude-desktop`), and `brigadier mcp`
  (serve brigadier's tools over stdio MCP).
- Worktree isolation: every slice runs in its own git worktree, sibling to
  the repository, and commits only on branches brigadier creates.
- The cross-vendor review gate: before a slice commits, a model from the
  other vendor reviews the exact diff and can block it; a blocking finding
  re-routes the retry to a different model.
- The plan document format: a JSON document naming slices, their owned paths,
  their dependencies, and the competence floor each requires, validated for
  shape and schedulability before any ref or worktree is created.

[unreleased]: https://github.com/stephen-golban/brigadier/compare/v0.1.1...HEAD
[0.1.1]: https://github.com/stephen-golban/brigadier/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/stephen-golban/brigadier/releases/tag/v0.1.0
