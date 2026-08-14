<p align="center">
  <b>exa</b> — the Exasol data agent
</p>

<p align="center">
  A terminal-native AI agent for working with your data: ask a question, watch
  the SQL before it runs, get an answer you can verify.
</p>

---

## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/Sheetaldharshan200/exa-engine/main/install.sh | sh
```

Windows: download the archive for your platform from the
[releases page](https://github.com/Sheetaldharshan200/exa/releases) and put
`exa.exe` on your `PATH`.

Then start it:

```sh
exa
```

## What it does

`exa` is built for data work, not code editing. It connects to your databases
through MCP servers, inspects real schemas, writes SQL, and explains what it
found — with the query it ran always visible.

- **Grounded in your schema.** It lists schemas and describes tables before it
  writes SQL, so column names come from your database and not from a guess.
- **Read-only by default.** Nothing mutates unless you grant it. `exa ops`
  turns on individual operation classes (insert, update, delete, create,
  alter, drop, access control, administration) and the agent refuses anything
  outside what you granted.
- **Sandboxed by default.** No internet access until you allow it with
  `exa sandbox on`.
- **Answers for you.** `exa persona` tunes depth and format — an executive
  gets the headline first, an analyst gets the SQL.
- **Teams for hard questions.** A multi-metric or multi-source question is
  planned, split across workers, independently verified, and reconciled
  before you see a number.

## Commands

| Command | What it does |
| --- | --- |
| `exa` | Start an interactive session |
| `exa run "<prompt>"` | One-shot prompt, non-interactive |
| `exa sandbox [status\|on\|off]` | Internet access for the agent |
| `exa ops [list\|grant\|revoke] <class…>` | SQL operations the agent may run |
| `exa persona [list\|set\|clear] <name>` | Who answers are written for |
| `exa models` | List available models |
| `exa serve` | Run the engine as a local HTTP server |

Inside a session, `/sandbox`, `/ops` and `/persona` open the same controls,
and `/help` lists everything.

## Configuration

Config lives at `~/.config/exa/exa.json` (or `EXA_CONFIG_DIR`). A project can
carry its own `.exa/exa.json`, which is merged on top.

```jsonc
{
  "model": "anthropic/claude-sonnet-4-6",
  "mcp": {
    "exasol": {
      "type": "local",
      "command": ["uvx", "exasol-mcp-server"],
      "enabled": true
    }
  }
}
```

Skills are folders containing a `SKILL.md`, discovered from `~/.claude/skills`,
`~/.agents/skills`, and a project's `.exa/skill` directory. Plugins are listed
in the `plugin` array as an npm package or a local path.

## Exasol Studio

`exa` is also the agent inside [Exasol Studio](https://exasol.com), where the
same engine, controls and personas are available in a graphical client
alongside the SQL editor and dashboards.

## Why Exasol

Exasol is an agentic database: built so AI agents can work on it directly, with
the concurrency to run many agents at once without them stepping on each other,
on an in-memory MPP engine that stays fast on real workloads — locally and in
the cloud. `exa` is that capability at your terminal.

## Development

```sh
bun install
bun run --cwd packages/exa src/index.ts     # run from source
bun turbo typecheck                          # typecheck every package
```

## License

MIT — see [LICENSE](LICENSE). Third-party components and their notices are
listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
