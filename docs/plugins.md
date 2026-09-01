# Exa engine plugins

Plugins extend the exa engine with your own hooks — react to events, wrap tool
calls, add behavior — packaged either as an npm package or as a single local
file. The engine loads them at startup; in Exasol Studio they're listed under
**Settings → AI → Tools & Plugins**.

## Create a plugin

The types live on npm as `exa-engine-plugin`, installed under the `@exa/plugin`
alias so the documented import works verbatim (verified with
`exa-engine-plugin@2026.1.85`):

```sh
npm i "@exa/plugin@npm:exa-engine-plugin" && npm i -D @types/node typescript
```

A plugin is a module with named exports; each export is an async function that
receives the engine context and returns the hooks it wants to handle:

```ts
// my-plugin.ts
import type { Plugin } from "@exa/plugin"

export const MyPlugin: Plugin = async ({ project, client, directory, $ }) => {
  return {
    // Observe or react to engine events (sessions, messages, tools…)
    event: async ({ event }) => {
      if (event.type === "session.idle") {
        await $`say "done"` // $ is a shell — runs on the user's machine
      }
    },
    // Wrap tool execution: inspect or veto args before a tool runs
    "tool.execute.before": async (input, output) => {
      if (input.tool === "bash" && String(output.args.command).includes("rm -rf")) {
        throw new Error("blocked by MyPlugin")
      }
    },
  }
}
```

Publish it to npm like any package (the engine's own packages live on npm as
`exa-ai` and friends), or keep it as a single `.ts`/`.js` file.

## Add a plugin

Two ways — both are picked up on the next engine start:

1. **Config entry** — add the spec to the `plugin` list in `exa.json`
   (global config, or an `exa.json` in your project):

   ```json
   {
     "plugin": [
       "my-plugin-package@1.2.0",
       "file:///absolute/path/to/my-plugin.ts"
     ]
   }
   ```

   npm specs are installed automatically; pin a version for reproducibility.

2. **Drop-in folder** — put the file in the config directory's `plugins/`
   folder (`<config>/plugins/my-plugin.ts`). Every `.ts`/`.js` file there
   loads automatically, no config edit needed.

### Where is the config?

- Plain CLI: `~/.config/exa/exa.json` (and `~/.config/exa/plugins/`).
- Exasol Studio's managed engine: the app pins the engine to its own config
  dir — `…/com.exasol.studio/personal-local/components/exa-agent/config/exa/`.
  The Studio settings page reads and writes that copy, so prefer managing
  grants there and use the same dir's `plugins/` folder for drop-ins.

## Good citizens

- Keep hooks fast — they run inline with the engine's loop.
- Never write secrets to disk or logs; read credentials from the engine's
  auth store instead of prompting.
- A plugin that throws in `tool.execute.before` blocks that tool call — use it
  for guardrails, not for routine control flow.
