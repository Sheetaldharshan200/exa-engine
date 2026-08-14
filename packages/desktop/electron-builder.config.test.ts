import { expect, test } from "bun:test"
import type { Configuration } from "electron-builder"

const legacyDesktopEntry = "resources/linux/exa-desktop.desktop"

const channels = [
  { channel: "dev", appId: "ai.exa.desktop.dev" },
  { channel: "beta", appId: "ai.exa.desktop.beta" },
  { channel: "prod", appId: "ai.exa.desktop" },
] as const

for (const channel of channels) {
  test(`uses one Linux desktop identity for ${channel.channel}`, async () => {
    const previous = process.env.EXA_CHANNEL
    process.env.EXA_CHANNEL = channel.channel

    const module = await import(`./electron-builder.config.ts?channel=${channel.channel}`)
    const config = module.default as Configuration

    if (previous === undefined) delete process.env.EXA_CHANNEL
    else process.env.EXA_CHANNEL = previous

    expect(config.appId).toBe(channel.appId)
    expect(config.extraMetadata?.desktopName).toBe(`${channel.appId}.desktop`)
    expect(config.linux?.executableName).toBe(channel.appId)
    expect(config.linux?.desktop?.entry?.StartupWMClass).toBe(channel.appId)
    expect(config.deb?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
    expect(config.rpm?.fpm).toContainEqual(expect.stringContaining(`/usr/share/metainfo/${channel.appId}.metainfo.xml`))
  })
}

test("keeps a hidden prod launcher for old Linux pins", async () => {
  const previous = process.env.EXA_CHANNEL
  process.env.EXA_CHANNEL = "prod"

  const module = await import("./electron-builder.config.ts?compat=prod")
  const config = module.default as Configuration

  if (previous === undefined) delete process.env.EXA_CHANNEL
  else process.env.EXA_CHANNEL = previous

  expect(
    config.deb?.fpm?.some((entry) =>
      entry.endsWith("exa-desktop.desktop=/usr/share/applications/exa-desktop.desktop"),
    ),
  ).toBe(true)
  expect(
    config.rpm?.fpm?.some((entry) =>
      entry.endsWith("exa-desktop.desktop=/usr/share/applications/exa-desktop.desktop"),
    ),
  ).toBe(true)

  const desktop = await Bun.file(legacyDesktopEntry).text()
  expect(desktop).toContain("Exec=/opt/Exa/ai.exa.desktop %U")
  expect(desktop).toContain("Icon=ai.exa.desktop")
  expect(desktop).toContain("StartupWMClass=ai.exa.desktop")
  expect(desktop).toContain("NoDisplay=true")
})

test("bundles the CLI outside the dev app archive", async () => {
  const previous = process.env.EXA_CHANNEL
  process.env.EXA_CHANNEL = "dev"
  const module = await import("./electron-builder.config.ts?cli-resource")
  const config = module.default as Configuration
  if (previous === undefined) delete process.env.EXA_CHANNEL
  else process.env.EXA_CHANNEL = previous

  expect(config.files).toContain("!resources/exa-cli*")
  expect(config.extraResources).toContainEqual({
    from: "resources/",
    to: "",
    filter: ["exa-cli*"],
  })
})

for (const channel of ["beta", "prod"] as const) {
  test(`does not bundle the CLI in ${channel} builds`, async () => {
    const previous = process.env.EXA_CHANNEL
    process.env.EXA_CHANNEL = channel
    const module = await import(`./electron-builder.config.ts?no-cli-resource=${channel}`)
    const config = module.default as Configuration
    if (previous === undefined) delete process.env.EXA_CHANNEL
    else process.env.EXA_CHANNEL = previous

    expect(config.extraResources).not.toContainEqual({
      from: "resources/",
      to: "",
      filter: ["exa-cli*"],
    })
  })
}
