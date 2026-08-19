export const appName = 'exa';
// Docs pages live at the root of the app; the /docs prefix comes from
// next.config's basePath, which the exa server serves them under.
export const docsRoute = '/';
export const docsImageRoute = '/og/docs';
export const docsContentRoute = '/llms.mdx/docs';
// basePath is not applied to plain fetch()/meta URLs, only to next/link.
export const withBasePath = (url: string) => `/docs${url === '/' ? '' : url}`;

export const gitConfig = {
  user: 'Sheetaldharshan200',
  repo: 'exa-engine',
  branch: 'main',
};
