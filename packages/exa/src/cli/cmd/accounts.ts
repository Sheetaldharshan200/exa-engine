/**
 * Multiple signed-in accounts per provider.
 *
 * The auth store keeps one active credential per provider (the plain provider
 * id) — that is what requests use. Extra accounts live in numbered slots
 * (`anthropic#1`, `anthropic#2`, …) that no provider id can collide with, and
 * switching swaps a slot with the active entry, so nothing is ever lost by
 * changing accounts.
 *
 * Adding a second account is: `exa accounts save <provider>` (stash the
 * current one), sign in again (`exa providers login` or `/connect`), then
 * `exa accounts use <provider> <slot>` whenever you want the first one back.
 */
import { Effect } from "effect"
import { cmd } from "./cmd"
import { effectCmd, fail } from "../effect-cmd"
import { UI } from "../ui"
import { Auth } from "../../auth"

const SLOT = /^(.+)#(\d+)$/

export function slotKey(provider: string, slot: number): string {
  return `${provider}#${slot}`
}

export function parseSlotKey(key: string): { provider: string; slot: number } | undefined {
  const match = SLOT.exec(key)
  if (!match) return undefined
  return { provider: match[1]!, slot: Number(match[2]) }
}

export function nextFreeSlot(keys: string[], provider: string): number {
  const taken = new Set(
    keys
      .map(parseSlotKey)
      .filter((parsed): parsed is { provider: string; slot: number } => parsed?.provider === provider)
      .map((parsed) => parsed.slot),
  )
  let slot = 1
  while (taken.has(slot)) slot++
  return slot
}

export function describeAccount(info: Auth.Info): string {
  if (info.type === "oauth") {
    const expired = info.expires < Date.now()
    const who = info.accountId ? `account ${info.accountId.slice(0, 8)}…` : "subscription"
    return `oauth ${who}${expired ? " (token expired, refreshes on use)" : ""}`
  }
  if (info.type === "api") {
    const key = info.key
    return `api key ${key.length > 10 ? `${key.slice(0, 6)}…${key.slice(-4)}` : "****"}`
  }
  return info.type
}

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const ListCommand = effectCmd({
  command: "list [provider]",
  describe: "list signed-in accounts per provider",
  instance: false,
  builder: (yargs) => yargs.positional("provider", { type: "string", describe: "only this provider" }),
  handler: Effect.fn("Cli.accounts.list")(function* (args) {
    const auth = yield* Auth.Service
    const all = yield* Effect.orDie(auth.all())

    const providers = new Map<string, { active?: Auth.Info; slots: Map<number, Auth.Info> }>()
    for (const [key, info] of Object.entries(all)) {
      const parsed = parseSlotKey(key)
      const provider = parsed?.provider ?? key
      if (args.provider && provider !== args.provider) continue
      const entry = providers.get(provider) ?? { slots: new Map<number, Auth.Info>() }
      if (parsed) entry.slots.set(parsed.slot, info)
      else entry.active = info
      providers.set(provider, entry)
    }

    if (providers.size === 0) {
      UI.println(dim(args.provider ? `No accounts for ${args.provider}.` : "No accounts signed in."))
      UI.println(dim("Sign in with `exa providers login` or /connect in the TUI."))
      return
    }

    for (const [provider, entry] of [...providers.entries()].sort(([a], [b]) => a.localeCompare(b))) {
      UI.println(UI.Style.TEXT_HIGHLIGHT_BOLD + provider + UI.Style.TEXT_NORMAL)
      if (entry.active) {
        UI.println(`  ${UI.Style.TEXT_SUCCESS}●${UI.Style.TEXT_NORMAL} active  ${describeAccount(entry.active)}`)
      }
      for (const [slot, info] of [...entry.slots.entries()].sort(([a], [b]) => a - b)) {
        UI.println(`    slot ${slot}  ${describeAccount(info)}`)
      }
    }
  }),
})

const SaveCommand = effectCmd({
  command: "save <provider>",
  describe: "stash the active account into a slot, freeing the active spot for a new sign-in",
  instance: false,
  builder: (yargs) => yargs.positional("provider", { type: "string", demandOption: true }),
  handler: Effect.fn("Cli.accounts.save")(function* (args) {
    const auth = yield* Auth.Service
    const all = yield* Effect.orDie(auth.all())
    const active = all[args.provider]
    if (!active) return yield* fail(`No active account for ${args.provider} — sign in first.`)

    const slot = nextFreeSlot(Object.keys(all), args.provider)
    yield* Effect.orDie(auth.set(slotKey(args.provider, slot), active))
    yield* Effect.orDie(auth.remove(args.provider))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Saved to slot ${slot}.` + UI.Style.TEXT_NORMAL)
    UI.println(dim(`Sign in to the next account with \`exa providers login\` (or /connect in the TUI),`))
    UI.println(dim(`then switch back any time with \`exa accounts use ${args.provider} ${slot}\`.`))
  }),
})

const UseCommand = effectCmd({
  command: "use <provider> <slot>",
  describe: "make a saved account the active one (the current active swaps into its slot)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("provider", { type: "string", demandOption: true })
      .positional("slot", { type: "number", demandOption: true }),
  handler: Effect.fn("Cli.accounts.use")(function* (args) {
    const auth = yield* Auth.Service
    const all = yield* Effect.orDie(auth.all())
    const key = slotKey(args.provider, args.slot)
    const saved = all[key]
    if (!saved) return yield* fail(`No slot ${args.slot} for ${args.provider} — see \`exa accounts list\`.`)

    const active = all[args.provider]
    // Swap rather than overwrite: switching accounts must never lose one.
    yield* Effect.orDie(auth.set(args.provider, saved))
    if (active) {
      yield* Effect.orDie(auth.set(key, active))
      UI.println(
        UI.Style.TEXT_SUCCESS_BOLD +
          `Now active: slot ${args.slot}. The previous account moved into that slot.` +
          UI.Style.TEXT_NORMAL,
      )
      return
    }
    yield* Effect.orDie(auth.remove(key))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Now active: slot ${args.slot}.` + UI.Style.TEXT_NORMAL)
  }),
})

const RemoveCommand = effectCmd({
  command: "remove <provider> [slot]",
  describe: "remove a saved slot (or the active account with no slot given)",
  instance: false,
  builder: (yargs) =>
    yargs
      .positional("provider", { type: "string", demandOption: true })
      .positional("slot", { type: "number" }),
  handler: Effect.fn("Cli.accounts.remove")(function* (args) {
    const auth = yield* Auth.Service
    const all = yield* Effect.orDie(auth.all())
    const key = args.slot === undefined ? args.provider : slotKey(args.provider, args.slot)
    if (!all[key]) return yield* fail(`Nothing stored at ${key}.`)
    yield* Effect.orDie(auth.remove(key))
    UI.println(UI.Style.TEXT_SUCCESS_BOLD + `Removed ${key}.` + UI.Style.TEXT_NORMAL)
  }),
})

export const AccountsCommand = cmd({
  command: "accounts",
  describe: "manage multiple signed-in accounts per provider",
  builder: (yargs) =>
    yargs.command(ListCommand).command(SaveCommand).command(UseCommand).command(RemoveCommand).demandCommand(),
  handler: () => {},
})
