# Documentation

This is the index of brigadier's documentation. Each document covers one
subject in depth; the top-level [README](../README.md) covers the product as
a whole.

| Document | What it covers |
| --- | --- |
| [CLI.md](CLI.md) | the complete command reference: every command, option, and exit code |
| [AGENT-SETUP.md](AGENT-SETUP.md) | a step-by-step guide for an AI agent setting brigadier up for a user |
| [PLAN-FORMAT.md](PLAN-FORMAT.md) | the plan document: every field, every validation rule, every error code |
| [REVIEW-GATE.md](REVIEW-GATE.md) | the cross-vendor review gate in depth |
| [HOSTS.md](HOSTS.md) | what `brigadier install` writes per host, and the limits of each |
| [METHODOLOGY.md](METHODOLOGY.md) | the routing policy, published so it can be audited for vendor bias |
| [RELEASING.md](RELEASING.md) | the release procedure |

## Start here

A human should start at [../README.md](../README.md), then
[HOSTS.md](HOSTS.md) — brigadier is primarily used from inside the AI coding
host you already have, not from a terminal — and [CLI.md](CLI.md) for the exact
command surface when you do want to drive it directly.

There is no setup step. [CLI.md](CLI.md#configuration-is-automatic) explains what
happens instead, and what the one remaining hard failure is.

An AI agent setting brigadier up on someone's behalf should start at
[AGENT-SETUP.md](AGENT-SETUP.md).
