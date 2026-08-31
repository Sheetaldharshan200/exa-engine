import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

/** The Exasol X — the green stroke is brand-fixed, the dark stroke follows
 *  the text color so the mark reads on both themes. */
function ExasolX() {
  return (
    <svg width="20" height="20" viewBox="0 0 250 250" fill="none" aria-hidden="true">
      <path
        d="M169.575 33.6724L134.68 79.5116L161.797 114.671L223.871 33.759L169.575 33.6724ZM161.797 135.548L134.68 170.695L169.575 216.534L223.871 216.46L161.797 135.548Z"
        fill="currentColor"
      />
      <path
        d="M27.2866 216.538L97.936 124.948L27.6179 33.79L81.8793 33.8217L152.172 124.946L81.531 216.535L27.2866 216.538Z"
        fill="#5FC33B"
      />
    </svg>
  );
}

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <>
          <ExasolX />
          <span className="font-semibold tracking-tight text-[15px]">{appName}</span>
          <span className="text-fd-muted-foreground text-[13px] font-normal border-l ps-2 ms-0.5">docs</span>
        </>
      ),
    },
    links: [
      { text: 'Documentation', url: '/', active: 'nested-url' },
      {
        type: 'menu',
        text: 'Releases',
        items: [
          {
            text: 'Exa · AI engine',
            description: 'CLI + engine releases',
            url: `https://github.com/${gitConfig.user}/${gitConfig.repo}/releases`,
            external: true,
          },
          {
            text: 'Exasol Studio · IDE',
            description: 'Desktop app releases',
            url: 'https://github.com/Sheetaldharshan200/Exasol-studio/releases',
            external: true,
          },
        ],
      },
      {
        type: 'menu',
        text: 'GitHub',
        items: [
          { text: 'exa-engine', url: `https://github.com/${gitConfig.user}/${gitConfig.repo}`, external: true },
          { text: 'Exasol-studio', url: 'https://github.com/Sheetaldharshan200/Exasol-studio', external: true },
        ],
      },
    ],
    // The three-way segmented pill: light / dark / follow-the-system.
    themeSwitch: { mode: 'light-dark-system' },
  };
}
