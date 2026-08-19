import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

/** The CLI's data-wave motif: three ascending bars. */
function Logo() {
  return (
    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <rect x="3" y="13" width="4.5" height="8" rx="1.2" fill="currentColor" opacity="0.4" />
      <rect x="9.75" y="8" width="4.5" height="13" rx="1.2" fill="currentColor" opacity="0.68" />
      <rect x="16.5" y="3" width="4.5" height="18" rx="1.2" fill="currentColor" />
    </svg>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <Logo />
          <span className="font-semibold tracking-tight">{appName}</span>
        </>
      ),
    },
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
