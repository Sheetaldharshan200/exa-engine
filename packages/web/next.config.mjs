import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  // Served by the exa binary under /docs, next to the Studio UI at the root.
  basePath: '/docs',
  reactStrictMode: true,
  images: { unoptimized: true },
};

export default withMDX(config);
