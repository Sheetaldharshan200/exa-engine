import { describe, expect, test } from "bun:test"
import { MODELS, assetFragment, findModel, fitsInMemory, formatSize, pickAsset } from "./catalog"

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
