import type {SidebarsConfig} from '@docusaurus/plugin-content-docs';

const sidebars: SidebarsConfig = {
  docsSidebar: [
    {
      type: 'category',
      label: 'Getting Started',
      items: [
        'getting-started/quickstart',
        'getting-started/installation',
        'getting-started/updating',
        'getting-started/uninstall',
      ],
    },
    {
      type: 'category',
      label: 'User Guide',
      items: [
        'user-guide/cli',
        'user-guide/sessions',
        'user-guide/profiles',
        'user-guide/providers',
        'user-guide/tools',
        'user-guide/skills',
        'user-guide/memory',
        'user-guide/security-and-approvals',
        'user-guide/gateway',
        'user-guide/channels',
        'user-guide/browser',
        'user-guide/voice',
        'user-guide/image-generation',
      ],
    },
    {
      type: 'category',
      label: 'Reference',
      items: [
        'reference/cli-commands',
        'reference/slash-commands',
        'reference/configuration',
        'reference/environment-variables',
        'reference/provider-reference',
        'reference/tools-reference',
        'reference/state-and-files',
        'reference/troubleshooting',
        'reference/faq',
      ],
    },
    {
      type: 'category',
      label: 'Operations',
      items: [
        'operations/testing',
        'operations/release-process',
        'operations/maintenance',
        'operations/backups-and-state',
        'operations/known-issues',
        'operations/gateway-operations',
        'operations/update-operations',
      ],
    },
    {
      type: 'category',
      label: 'Developer',
      items: [
        'developer/architecture',
        'developer/runtime',
        'developer/provider-runtime',
        'developer/tool-runtime',
        'developer/memory-architecture',
        'developer/gateway-internals',
        'developer/contributing-internals',
      ],
    },
  ],
};

export default sidebars;
