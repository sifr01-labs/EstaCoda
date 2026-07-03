import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'EstaCoda',
  tagline: 'A CLI AI agent runtime with multi-channel, multi-provider, and multi-tool support.',

  favicon: 'img/favicon.svg',

  stylesheets: [
    {
      href: 'https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,500;0,600;0,700;1,500;1,600&family=Geist:wght@300;400;500;600;700&family=Geist+Mono:wght@400;500;600;700&family=Cairo:wght@400;500;600;700&display=swap',
      rel: 'stylesheet',
    },
  ],

  url: 'https://www.estacoda.com',
  baseUrl: '/docs/',
  trailingSlash: true,

  organizationName: 'sifr01-labs',
  projectName: 'EstaCoda',

  onBrokenLinks: 'throw',

  i18n: {
    defaultLocale: 'en',
    locales: ['en', 'ar'],
    localeConfigs: {
      en: {
        label: 'English',
        direction: 'ltr',
        htmlLang: 'en',
      },
      ar: {
        label: 'العربية',
        direction: 'rtl',
        htmlLang: 'ar',
      },
    },
  },

  presets: [
    [
      'classic',
      {
        docs: {
          routeBasePath: '/',
          sidebarPath: './sidebars.ts',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themes: [
    [
      '@easyops-cn/docusaurus-search-local',
      {
        hashed: true,
        language: ['en', 'ar'],
        indexBlog: false,
        docsRouteBasePath: '/',
        highlightSearchTermsOnTargetPage: false,
      },
    ],
  ],

  themeConfig: {
    colorMode: {
      defaultMode: 'light',
      respectPrefersColorScheme: true,
    },
    navbar: {
      title: 'estacoda',
      logo: {
        alt: 'EstaCoda',
        src: 'img/logo-light.svg',
        srcDark: 'img/logo-dark.svg',
        // Point the brand mark at the main marketing site, not the docs root.
        href: 'https://www.estacoda.com/',
        target: '_self',
      },
      items: [
        {
          to: '/getting-started/quickstart/',
          label: '/docs',
          position: 'left',
          activeBaseRegex: '^/$|^/(?!ar(?:/|$)).*$',
        },
        {
          href: 'https://www.estacoda.com/skills',
          label: '/skills',
          position: 'left',
        },
        {
          href: 'https://github.com/sifr01-labs/EstaCoda',
          label: 'GitHub',
          position: 'right',
        },
        {
          type: 'localeDropdown',
          position: 'right',
        },
      ],
    },
    footer: {
      style: 'light',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Getting Started',
              to: '/getting-started/quickstart/',
            },
            {
              label: 'User Guide',
              to: '/user-guide/cli',
            },
          ],
        },
        {
          title: 'Community',
          items: [
            {
              label: 'GitHub',
              href: 'https://github.com/sifr01-labs/EstaCoda',
            },
          ],
        },
        {
          title: 'Security',
          items: [
            {
              label: 'Security Policy',
              href: 'https://github.com/sifr01-labs/EstaCoda/blob/main/SECURITY.md',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} KemetResearch.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
