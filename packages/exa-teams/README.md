# @exa/teams

Multi-agent data teams for the Exa engine — the foundation of Exa's
orchestration layer (teams, spawning, shared task queues with dependencies,
atomic claiming, peer messaging, crash recovery, rate limiting, watchdog).

Vendored from [hueyexe/opencode-ensemble](https://github.com/hueyexe/opencode-ensemble)
(MIT — see LICENSE) and evolved for data workloads: the roadmap replaces
coding-team roles with data-team roles (semantic planner, source discovery,
SQL analysts, validators, reconciler, answer synthesizer) per the
exa-data-ensemble design.

Loaded as a BUILT-IN plugin (packages/exa/src/plugin/index.ts), so both
the CLI and the Exasol Studio app get it with zero extra installation.

Fork-only package: upstream syncs never touch this directory.
