// @ts-check
import { defineConfig } from "astro/config"
import starlight from "@astrojs/starlight"
import solidJs from "@astrojs/solid-js"
import theme from "toolbeam-docs-theme"
import config from "./config.mjs"
import { rehypeHeadingIds } from "@astrojs/markdown-remark"
import rehypeAutolinkHeadings from "rehype-autolink-headings"

// Static output, embedded into the exa binary and served locally by
// `exa docs`. The docs run where the product runs; no host, no adapter.
export default defineConfig({
  site: config.url,
  base: "/docs",
  output: "static",
  devToolbar: { enabled: false },
  markdown: {
    rehypePlugins: [rehypeHeadingIds, [rehypeAutolinkHeadings, { behavior: "wrap" }]],
  },
  integrations: [
    solidJs(),
    starlight({
      title: "Exa",
      lastUpdated: true,
      expressiveCode: { themes: ["github-light", "github-dark"] },
      social: [{ icon: "github", label: "GitHub", href: config.github }],
      editLink: { baseUrl: `${config.github}/edit/main/packages/web/` },
      markdown: { headingLinks: false },
      customCss: ["./src/styles/custom.css"],
      logo: {
        light: "./src/assets/logo-light.svg",
        dark: "./src/assets/logo-dark.svg",
        replacesTitle: true,
      },
      sidebar: [
        "",
        { label: "Usage", items: ["tui", "cli", "web", "ide", "github", "gitlab"] },
        { label: "Data", items: ["databases", "local-models"] },
        {
          label: "Configure",
          items: [
            "config",
            "providers",
            "models",
            "agents",
            "permissions",
            "policies",
            "tools",
            "custom-tools",
            "commands",
            "skills",
            "rules",
            "mcp-servers",
            "keybinds",
            "themes",
            "formatters",
            "lsp",
            "acp",
          ],
        },
        { label: "Reference", items: ["network", "troubleshooting", "windows-wsl", "references"] },
        { label: "Develop", items: ["sdk", "server", "plugins", "ecosystem"] },
      ],
      components: {
        Hero: "./src/components/Hero.astro",
        Head: "./src/components/Head.astro",
        Header: "./src/components/Header.astro",
        Footer: "./src/components/Footer.astro",
        SiteTitle: "./src/components/SiteTitle.astro",
      },
      plugins: [theme({ headerLinks: config.headerLinks })],
    }),
  ],
})
