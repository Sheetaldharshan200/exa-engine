import { describe, expect, test } from "bun:test"
import { MODELS, assetFragment, chooseContext, findModel, fitsInMemory, formatSize, pickAsset } from "./catalog"

// Real asset names from a llama.cpp release. Picking the wrong one downloads
// ~50MB that cannot execute, and the failure surfaces as a confusing exec
// error rather than "wrong build".
const RELEASE_ASSETS = [
  "llama-b4327-bin-macos-arm64.tar.gz",
  "llama-b4327-bin-macos-x64.tar.gz",
  "llama-b4327-bin-ubuntu-x64.tar.gz",
  "llama-b4327-bin-ubuntu-arm64.tar.gz",
  "llama-b4327-bin-win-cpu-x64.zip",
  "llama-b4327-bin-win-cpu-arm64.zip",
  "llama-b4327-bin-win-cuda-x64.zip",
  "cudart-llama-bin-win-cuda-12.4-x64.zip",
]

describe("assetFragment", () => {
  test("maps each supported platform to its build", () => {
    expect(assetFragment("darwin", "arm64")).toBe("-bin-macos-arm64.")
    expect(assetFragment("darwin", "x64")).toBe("-bin-macos-x64.")
    expect(assetFragment("linux", "x64")).toBe("-bin-ubuntu-x64.")
    expect(assetFragment("linux", "arm64")).toBe("-bin-ubuntu-arm64.")
    expect(assetFragment("win32", "x64")).toBe("-bin-win-cpu-x64.")
    expect(assetFragment("win32", "arm64")).toBe("-bin-win-cpu-arm64.")
  })

  // Saying so beats downloading something that cannot run.
  test("reports nothing where llama.cpp publishes no build", () => {
    expect(assetFragment("freebsd", "x64")).toBeUndefined()
    expect(assetFragment("linux", "ppc64")).toBeUndefined()
  })
})

describe("pickAsset", () => {
  test("picks this machine's build out of the full asset list", () => {
    expect(pickAsset(RELEASE_ASSETS, assetFragment("darwin", "arm64"))).toBe("llama-b4327-bin-macos-arm64.tar.gz")
    expect(pickAsset(RELEASE_ASSETS, assetFragment("win32", "x64"))).toBe("llama-b4327-bin-win-cpu-x64.zip")
  })

  // An arm64 Windows machine must not take the x64 build merely because both
  // end in .zip — matching on the fragment, not the extension, is what
  // prevents it.
  test("never picks a build for another architecture", () => {
    const picked = pickAsset(RELEASE_ASSETS, assetFragment("win32", "arm64"))
    expect(picked).toBe("llama-b4327-bin-win-cpu-arm64.zip")
    expect(picked).not.toContain("x64")
  })

  // A CUDA build on a machine with no NVIDIA GPU will not start.
  test("takes the CPU-safe Windows build, not the CUDA one", () => {
    expect(pickAsset(RELEASE_ASSETS, assetFragment("win32", "x64"))).not.toContain("cuda")
  })

  test("reports nothing on an unsupported platform", () => {
    expect(pickAsset(RELEASE_ASSETS, assetFragment("freebsd", "x64"))).toBeUndefined()
  })

  test("reports nothing when the release has no matching asset", () => {
    expect(pickAsset(["llama-b1-bin-something-else.tar.gz"], "-bin-macos-arm64.")).toBeUndefined()
  })
})

describe("findModel", () => {
  test("finds by id, by name, and by a partial id", () => {
    expect(findModel("qwen3-4b")?.id).toBe("qwen3-4b")
    expect(findModel("Qwen3 4B Instruct")?.id).toBe("qwen3-4b")
    expect(findModel("coder")?.id).toBe("qwen2.5-coder-7b")
  })

  test("ignores case and space", () => {
    expect(findModel("  QWEN3-4B ")?.id).toBe("qwen3-4b")
  })

  test("reports nothing for a model that is not offered", () => {
    expect(findModel("gpt-4o")).toBeUndefined()
  })
})

describe("fitsInMemory", () => {
  const big = MODELS.find((m) => m.id === "qwen2.5-coder-7b")!
  const small = MODELS.find((m) => m.id === "llama-3.2-3b")!

  // Telling the user up front beats a 4GB download that then swaps to death.
  test("refuses a model the machine cannot hold", () => {
    expect(fitsInMemory(big, 8 * 1024 ** 3)).toBe(false)
    expect(fitsInMemory(big, 16 * 1024 ** 3)).toBe(true)
  })

  test("accepts a small model on a small machine", () => {
    expect(fitsInMemory(small, 8 * 1024 ** 3)).toBe(true)
  })
})

describe("the catalogue itself", () => {
  // A model that cannot call tools answers in prose about querying the
  // database instead of querying it, which is a baffling way to fail.
  test("every entry is a real GGUF over https with a size and a floor", () => {
    for (const model of MODELS) {
      expect(model.url.startsWith("https://")).toBe(true)
      expect(model.url.endsWith(".gguf")).toBe(true)
      expect(model.file.endsWith(".gguf")).toBe(true)
      expect(model.sizeMB).toBeGreaterThan(0)
      expect(model.minRamGB).toBeGreaterThan(0)
    }
  })

  test("ids are unique", () => {
    expect(new Set(MODELS.map((m) => m.id)).size).toBe(MODELS.length)
  })
})

describe("formatSize", () => {
  test("reads in the unit a person would use", () => {
    expect(formatSize(512)).toBe("512 MB")
    expect(formatSize(2500)).toBe("2.4 GB")
  })
})

describe("stopping the engine", () => {
  test("looks only for the listener, never for clients", async () => {
    const { listenerLookup } = await import("./engine")
    // Without -sTCP:LISTEN, lsof also reports every process CONNECTED to the
    // port. exa holds such a connection while detecting the engine, so
    // restarting a model killed the user's own session.
    expect(listenerLookup(41414)).toEqual(["lsof", "-ti", "tcp:41414", "-sTCP:LISTEN"])
  })

  test("never signals this process, whatever lsof reported", async () => {
    const { killable } = await import("./engine")
    expect(killable("69622\n77490\n", 77490)).toEqual(["69622"])
    expect(killable("77490\n", 77490)).toEqual([])
  })

  test("handles no listener at all", async () => {
    const { killable } = await import("./engine")
    expect(killable("", 123)).toEqual([])
    expect(killable("\n  \n", 123)).toEqual([])
  })
})

describe("chooseContext", () => {
  const llama = MODELS.find((m) => m.id === "llama-3.2-3b")!
  const coder = MODELS.find((m) => m.id === "qwen2.5-coder-7b")!
  const GB = 1024 ** 3

  // "Use the maximum" is right as an aim and wrong as an instruction: the KV
  // cache is charged per token of window, so the full 128k for this model
  // needs several GB on top of the weights.
  test("gives a large machine the model's full window", () => {
    expect(chooseContext(llama, 128 * GB)).toBe(llama.contextMax)
  })

  test("reduces it on a machine that cannot hold it", () => {
    const chosen = chooseContext(llama, 8 * GB)
    expect(chosen).toBeLessThan(llama.contextMax)
    expect(chosen).toBeGreaterThanOrEqual(8_192)
  })

  // Halving keeps the number recognisable — a user reading 65,536 can tell
  // what happened to it.
  test("reduces by halving, so the result stays a familiar size", () => {
    const chosen = chooseContext(llama, 16 * GB)
    expect(llama.contextMax % chosen).toBe(0)
    expect(Number.isInteger(Math.log2(chosen))).toBe(true)
  })

  // Below this the agent's own system prompt does not fit, so a smaller
  // window is not a degraded experience but a broken one.
  test("never goes below a window that can hold the system prompt", () => {
    expect(chooseContext(llama, 1 * GB)).toBe(8_192)
    expect(chooseContext(coder, 1 * GB)).toBe(8_192)
  })

  // Grouped-query attention makes this model's context far cheaper per token,
  // so it should keep its full window where a denser model could not.
  test("respects that a cheaper cache reaches further", () => {
    expect(chooseContext(coder, 32 * GB)).toBe(coder.contextMax)
  })

  test("never exceeds what the model was trained for", () => {
    for (const model of MODELS) {
      expect(chooseContext(model, 512 * GB)).toBeLessThanOrEqual(model.contextMax)
    }
  })
})
