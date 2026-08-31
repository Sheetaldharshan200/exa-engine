import { describe, expect, test } from "bun:test"
import { LOCAL_PROVIDERS, providerOptions } from "./dialog-provider"

// A realistic slice: the list the dialog actually receives is ~190 entries, so
// anything not deliberately lifted is effectively invisible.
const LIST = [
  { id: "abacus", name: "Abacus" },
  { id: "anthropic", name: "Anthropic" },
  { id: "builtin", name: "Exa engine (local)" },
  { id: "ollama", name: "Ollama (local)" },
  { id: "openai", name: "OpenAI" },
  { id: "zhipu", name: "Zhipu" },
]

describe("providerOptions", () => {
  // The complaint this fixes: the local engine looked absent because it sat
  // alphabetically among ~190 providers with nothing marking it out.
  test("puts what runs on this machine first", () => {
    const options = providerOptions(LIST)
    expect(options.slice(0, 2).map((o) => o.value)).toEqual(["builtin", "ollama"])
  })

  test("files them under their own heading", () => {
    const options = providerOptions(LIST)
    for (const id of ["builtin", "ollama"]) {
      expect(options.find((o) => o.value === id)?.category).toBe("On this machine")
    }
  })

  // Saying "(API key)" next to a local server promises a step that does not
  // exist — there is no credential to obtain.
  test("says no key is needed rather than implying one", () => {
    const options = providerOptions(LIST)
    for (const id of ["builtin", "ollama"]) {
      const description = options.find((o) => o.value === id)?.description ?? ""
      expect(description).toContain("no key needed")
    }
  })

  test("leaves the cloud providers as they were", () => {
    const options = providerOptions(LIST)
    expect(options.find((o) => o.value === "openai")?.category).toBe("Popular")
    expect(options.find((o) => o.value === "zhipu")?.category).toBe("Providers")
  })

  test("knows which providers are local", () => {
    expect(LOCAL_PROVIDERS.has("ollama")).toBe(true)
    expect(LOCAL_PROVIDERS.has("builtin")).toBe(true)
    expect(LOCAL_PROVIDERS.has("openai")).toBe(false)
  })
})
