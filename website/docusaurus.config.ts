import {themes as prismThemes} from 'prism-react-renderer';
import type {Config} from '@docusaurus/types';
import type * as Preset from '@docusaurus/preset-classic';

const config: Config = {
  title: 'EstaCoda',
  tagline: 'A CLI AI agent runtime with multi-channel, multi-provider, and multi-tool support.',

  // TODO: add favicon and social-card image under static/img/ when branding assets are ready

  url: 'https://estacoda.kemetresearch.com',
  baseUrl: '/docs/',
  trailingSlash: true,

  organizationName: 'KemetResearch',
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
          editUrl: 'https://github.com/KemetResearch/EstaCoda/tree/main/website/',
        },
        blog: false,
        theme: {
          customCss: './src/css/custom.css',
        },
      } satisfies Preset.Options,
    ],
  ],

  themeConfig: {
    // TODO: configure local search (e.g. @easyops-cn/docusaurus-search-local) once dependency friction is resolved
    navbar: {
      title: 'EstaCoda',
      items: [
        {
          type: 'docSidebar',
          sidebarId: 'docsSidebar',
          position: 'left',
          label: 'Docs',
        },
        {
          href: 'https://github.com/KemetResearch/EstaCoda',
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
      style: 'dark',
      links: [
        {
          title: 'Docs',
          items: [
            {
              label: 'Getting Started',
              to: '/getting-started/',
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
              href: 'https://github.com/KemetResearch/EstaCoda',
            },
          ],
        },
        {
          title: 'Security',
          items: [
            {
              label: 'Security Policy',
              href: 'https://github.com/KemetResearch/EstaCoda/blob/main/SECURITY.md',
            },
          ],
        },
      ],
      copyright: `Copyright © ${new Date().getFullYear()} KemetResearch. Built with Docusaurus.`,
    },
    prism: {
      theme: prismThemes.github,
      darkTheme: prismThemes.dracula,
    },
  } satisfies Preset.ThemeConfig,
};

export default config;
