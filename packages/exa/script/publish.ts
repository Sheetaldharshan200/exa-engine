#!/usr/bin/env bun
import { $ } from "bun"
import pkg from "../package.json"
import { Script } from "@exa/script"
import { fileURLToPath } from "url"

const dir = fileURLToPath(new URL("..", import.meta.url))
process.chdir(dir)

async function published(name: string, version: string) {
  return (await $`npm view ${name}@${version} version`.nothrow()).exitCode === 0
}

async function publish(dir: string, name: string, version: string) {
  // GitHub artifact downloads can drop the executable bit, and Docker uses the
  // unpacked dist binaries directly rather than the published tarball.
  if (process.platform !== "win32") await $`chmod -R 755 .`.cwd(dir)
  if (await published(name, version)) {
    console.log(`already published ${name}@${version}`)
    return
  }
  await $`bun pm pack`.cwd(dir)
  await $`npm publish *.tgz --access public --tag ${Script.channel}`.cwd(dir)
}

const binaries: Record<string, string> = {}
for (const filepath of new Bun.Glob("*/package.json").scanSync({ cwd: "./dist" })) {
  const pkg = await Bun.file(`./dist/${filepath}`).json()
  binaries[pkg.name] = pkg.version
}
console.log("binaries", binaries)
const version = Object.values(binaries)[0]

await $`mkdir -p ./dist/${pkg.name}`
await $`mkdir -p ./dist/${pkg.name}/bin`
await $`cp ./script/postinstall.mjs ./dist/${pkg.name}/postinstall.mjs`
await Bun.file(`./dist/${pkg.name}/LICENSE`).write(await Bun.file("../../LICENSE").text())
await Bun.file(`./dist/${pkg.name}/bin/${pkg.name}.exe`).write(
  [
    `echo "Error: ${pkg.name}-ai's postinstall script was not run." >&2`,
    'echo "" >&2',
    'echo "This occurs when using --ignore-scripts during installation, or when using a" >&2',
    'echo "package manager like pnpm that does not run postinstall scripts by default." >&2',
    'echo "" >&2',
    'echo "To fix this, run the postinstall script manually:" >&2',
    `echo "  cd node_modules/${pkg.name}-ai && node postinstall.mjs" >&2`,
    'echo "" >&2',
    `echo "Or reinstall ${pkg.name}-ai without the --ignore-scripts flag." >&2`,
    "exit 1",
    "",
  ].join("\n"),
)

await Bun.file(`./dist/${pkg.name}/package.json`).write(
  JSON.stringify(
    {
      name: pkg.name + "-ai",
      bin: {
        [pkg.name]: `./bin/${pkg.name}.exe`,
      },
      scripts: {
        postinstall: "node ./postinstall.mjs",
      },
      version: version,
      license: pkg.license,
      os: ["darwin", "linux", "win32"],
      cpu: ["arm64", "x64"],
      optionalDependencies: binaries,
    },
    null,
    2,
  ),
)

const tasks = Object.entries(binaries).map(async ([name]) => {
  await publish(`./dist/${name}`, name, binaries[name])
})
await Promise.all(tasks)
await publish(`./dist/${pkg.name}`, `${pkg.name}-ai`, version)

// ── SDK and plugin libraries ─────────────────────────────────────────────────
// Internal imports say "@exa/sdk" and "@exa/plugin", but the @exa scope on npm
// is not ours to claim, so the packages publish under exa-engine-* names.
// Consumers install them as aliases — `npm i @exa/sdk@npm:exa-engine-sdk` —
// which keeps every documented import working verbatim, and the runtime
// installs the plugin package the same way for plugin authors (config.ts).
async function publishLibrary(sourceDir: string, publishedName: string, dependencies: Record<string, string>) {
  const src = await Bun.file(`../../${sourceDir}/package.json`).json()
  await $`bunx tsc -p ${sourceDir}`.cwd("../..")
  const stage = `./dist/${publishedName}`
  await $`rm -rf ${stage}`
  await $`mkdir -p ${stage}`
  await $`cp -R ../../${sourceDir}/dist ${stage}/dist`
  await Bun.file(`${stage}/LICENSE`).write(await Bun.file("../../LICENSE").text())

  // The source exports map points at src/*.ts for workspace use; the published
  // one points at the compiled output with its declarations.
  const exports = Object.fromEntries(
    Object.entries(src.exports as Record<string, string>).map(([key, value]) => {
      const base = value.replace(/^\.\/src\//, "./dist/").replace(/\.ts$/, "")
      return [key, { types: `${base}.d.ts`, default: `${base}.js` }]
    }),
  )

  await Bun.file(`${stage}/package.json`).write(
    JSON.stringify(
      {
        name: publishedName,
        version,
        type: "module",
        license: src.license,
        description: src.description,
        repository: { type: "git", url: "git+https://github.com/Sheetaldharshan200/exa-engine.git" },
        exports,
        files: ["dist"],
        dependencies,
      },
      null,
      2,
    ),
  )
  await publish(stage, publishedName, version)
}

await publishLibrary("packages/sdk/js", "exa-engine-sdk", {
  "cross-spawn": "7.0.6",
})
await publishLibrary("packages/plugin", "exa-engine-plugin", {
  "@ai-sdk/provider": "3.0.8",
  // Alias: the compiled output imports "@exa/sdk", published as exa-engine-sdk.
  "@exa/sdk": `npm:exa-engine-sdk@${version}`,
  effect: "4.0.0-beta.83",
  zod: "4.1.8",
})

const image = "ghcr.io/sheetaldharshan200/exa-engine"
const platforms = "linux/amd64,linux/arm64"
const tags = [`${image}:${version}`, `${image}:${Script.channel}`]
const tagFlags = tags.flatMap((t) => ["-t", t])

// registries
// Each distribution channel needs its own credential (a docker login for
// GHCR, an SSH key for the AUR, a homebrew-tap repository). They are opted
// into individually so a missing credential skips its channel with a notice
// instead of failing the whole publish after npm already succeeded.
if (!Script.preview && process.env["EXA_PUBLISH_DOCKER"] === "1") {
  await $`docker buildx build --platform ${platforms} ${tagFlags} --push .`
  // Calculate SHA values
  const arm64Sha = await $`sha256sum ./dist/exa-linux-arm64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const x64Sha = await $`sha256sum ./dist/exa-linux-x64.tar.gz | cut -d' ' -f1`.text().then((x) => x.trim())
  const macX64Sha = await $`sha256sum ./dist/exa-darwin-x64.zip | cut -d' ' -f1`.text().then((x) => x.trim())
  const macArm64Sha = await $`sha256sum ./dist/exa-darwin-arm64.zip | cut -d' ' -f1`.text().then((x) => x.trim())

  const [pkgver, _subver = ""] = Script.version.split(/(-.*)/, 2)

  // arch
  const binaryPkgbuild = [
    "# Maintainer: dax",
    "# Maintainer: adam",
    "",
    "pkgname='exa-bin'",
    `pkgver=${pkgver}`,
    `_subver=${_subver}`,
    "options=('!debug' '!strip')",
    "pkgrel=1",
    "pkgdesc='The AI coding agent built for the terminal.'",
    "url='https://github.com/Sheetaldharshan200/exa-engine'",
    "arch=('aarch64' 'x86_64')",
    "license=('MIT')",
    "provides=('exa')",
    "conflicts=('exa')",
    "depends=('ripgrep')",
    "",
    `source_aarch64=("\${pkgname}_\${pkgver}_aarch64.tar.gz::https://github.com/Sheetaldharshan200/exa-engine/releases/download/v\${pkgver}\${_subver}/exa-linux-arm64.tar.gz")`,
    `sha256sums_aarch64=('${arm64Sha}')`,

    `source_x86_64=("\${pkgname}_\${pkgver}_x86_64.tar.gz::https://github.com/Sheetaldharshan200/exa-engine/releases/download/v\${pkgver}\${_subver}/exa-linux-x64.tar.gz")`,
    `sha256sums_x86_64=('${x64Sha}')`,
    "",
    "package() {",
    '  install -Dm755 ./exa "${pkgdir}/usr/bin/exa"',
    "}",
    "",
  ].join("\n")

  for (const [pkg, pkgbuild] of process.env["EXA_PUBLISH_AUR"] === "1" ? [["exa-bin", binaryPkgbuild]] : []) {
    for (let i = 0; i < 30; i++) {
      try {
        await $`rm -rf ./dist/aur-${pkg}`
        await $`git clone ssh://aur@aur.archlinux.org/${pkg}.git ./dist/aur-${pkg}`
        await $`cd ./dist/aur-${pkg} && git checkout master`
        await Bun.file(`./dist/aur-${pkg}/PKGBUILD`).write(pkgbuild)
        await $`cd ./dist/aur-${pkg} && makepkg --printsrcinfo > .SRCINFO`
        await $`cd ./dist/aur-${pkg} && git add PKGBUILD .SRCINFO`
        if ((await $`cd ./dist/aur-${pkg} && git diff --cached --quiet`.nothrow()).exitCode === 0) break
        await $`cd ./dist/aur-${pkg} && git commit -m "Update to v${Script.version}"`
        await $`cd ./dist/aur-${pkg} && git push`
        break
      } catch {
        continue
      }
    }
  }

  // Homebrew formula
  const homebrewFormula = [
    "# typed: false",
    "# frozen_string_literal: true",
    "",
    "# This file was generated by GoReleaser. DO NOT EDIT.",
    "class Exa < Formula",
    `  desc "The AI coding agent built for the terminal."`,
    `  homepage "https://github.com/Sheetaldharshan200/exa-engine"`,
    `  version "${Script.version.split("-")[0]}"`,
    "",
    `  depends_on "ripgrep"`,
    "",
    "  on_macos do",
    "    if Hardware::CPU.intel?",
    `      url "https://github.com/Sheetaldharshan200/exa-engine/releases/download/v${Script.version}/exa-darwin-x64.zip"`,
    `      sha256 "${macX64Sha}"`,
    "",
    "      def install",
    '        bin.install "exa"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm?",
    `      url "https://github.com/Sheetaldharshan200/exa-engine/releases/download/v${Script.version}/exa-darwin-arm64.zip"`,
    `      sha256 "${macArm64Sha}"`,
    "",
    "      def install",
    '        bin.install "exa"',
    "      end",
    "    end",
    "  end",
    "",
    "  on_linux do",
    "    if Hardware::CPU.intel? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/Sheetaldharshan200/exa-engine/releases/download/v${Script.version}/exa-linux-x64.tar.gz"`,
    `      sha256 "${x64Sha}"`,
    "      def install",
    '        bin.install "exa"',
    "      end",
    "    end",
    "    if Hardware::CPU.arm? and Hardware::CPU.is_64_bit?",
    `      url "https://github.com/Sheetaldharshan200/exa-engine/releases/download/v${Script.version}/exa-linux-arm64.tar.gz"`,
    `      sha256 "${arm64Sha}"`,
    "      def install",
    '        bin.install "exa"',
    "      end",
    "    end",
    "  end",
    "end",
    "",
    "",
  ].join("\n")

  const token = process.env.GITHUB_TOKEN
  if (process.env["EXA_PUBLISH_HOMEBREW"] !== "1" || !token) {
    console.log("skipping homebrew tap update (set EXA_PUBLISH_HOMEBREW=1 with a GITHUB_TOKEN, and create the homebrew-tap repo)")
    process.exit(0)
  }
  const tap = `https://x-access-token:${token}@github.com/Sheetaldharshan200/homebrew-tap.git`
  await $`rm -rf ./dist/homebrew-tap`
  await $`git clone ${tap} ./dist/homebrew-tap`
  await Bun.file("./dist/homebrew-tap/exa.rb").write(homebrewFormula)
  await $`cd ./dist/homebrew-tap && git add exa.rb`
  if ((await $`cd ./dist/homebrew-tap && git diff --cached --quiet`.nothrow()).exitCode !== 0) {
    await $`cd ./dist/homebrew-tap && git commit -m "Update to v${Script.version}"`
    await $`cd ./dist/homebrew-tap && git push`
  }
}
