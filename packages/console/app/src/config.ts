/**
 * Application-wide constants and configuration
 */
export const config = {
  // Base URL
  baseUrl: "https://opencode.ai",

  // GitHub
  github: {
    repoUrl: "https://github.com/anomalyco/exa",
    starsFormatted: {
      compact: "195K",
      full: "195,000",
    },
  },

  // Social links
  social: {
    twitter: "https://x.com/exa",
    discord: "https://discord.gg/exa",
  },

  // Static stats (used on landing page)
  stats: {
    contributors: "950",
    commits: "13,000",
    monthlyUsers: "16M",
  },
} as const
