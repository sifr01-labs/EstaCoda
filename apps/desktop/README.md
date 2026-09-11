# EstaCoda desktop

Private Electron client workspace. Run `pnpm desktop:dev` from the repository root.
`pnpm desktop:typecheck` checks the application; `pnpm desktop:package` builds an unsigned local application.
Forge packages the Vite bundles. The renderer never imports the core runtime. Native core dependencies belong to the standalone Node service, not Electron's ABI.

PR5 production capabilities are bootstrap and existing Work inspection. The approved design's remaining journeys use an explicitly isolated test build until their planned live milestones.
