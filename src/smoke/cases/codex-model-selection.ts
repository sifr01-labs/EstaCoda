import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import type { Prompt } from "../../cli/prompt-contract.js";
import { runModelSetupCodex } from "../../cli/model-setup-codex.js";
import { resolveProfileStateHome } from "../../config/profile-home.js";
import type { SmokeCase } from "../smoke-case.js";
import { makeTempDir } from "../fixtures/shared-setup.js";

export const codex_model_selection_case: SmokeCase = {
  id: "codex-model-selection",
  name: "Codex model selection reuses OAuth and cancels without changes",
  tags: ["setup", "providers"],
  run: async () => {
    const homeDir = await makeTempDir("estacoda-codex-selection-smoke-");
    const paths = resolveProfileStateHome({ homeDir, profileId: "default" });
    try {
      await mkdir(paths.profileRoot, { recursive: true });
      const config = JSON.stringify({ model: { provider: "codex", id: "gpt-5.5" }, security: { mode: "strict" } });
      const auth = JSON.stringify({ version: 1, providers: { codex: { authMethod: "oauth_device_pkce", accessToken: "synthetic-smoke-access" } } });
      await writeFile(paths.configPath, config);
      await writeFile(paths.authJsonPath, auth);
      let choice = "cancel";
      let picked = false;
      const prompt = (async () => {
        if (!picked) throw new Error("Credentials were requested before model selection.");
        return "1";
      }) as Prompt;
      prompt.select = async (input) => {
        picked = true;
        if (input.options.some(option => option.id === "gpt-5.5")) throw new Error("Retired model offered for setup.");
        const selected = input.options.find(option => option.id === choice);
        if (!selected) throw new Error("Requested model choice missing.");
        return selected.value;
      };
      const options = { homeDir, profileId: "default", workspaceRoot: homeDir, prompt, fetchLike: async () => { throw new Error("Existing OAuth should be reused."); } };
      await runModelSetupCodex(options);
      if (await readFile(paths.configPath, "utf8") !== config) throw new Error("Cancelled setup changed config.");
      choice = "gpt-6-luna";
      const result = await runModelSetupCodex(options);
      const saved = JSON.parse(await readFile(paths.configPath, "utf8"));
      if (result.exitCode !== 0 || saved.model.id !== choice || saved.security.mode !== "strict") throw new Error("Selected Codex route was not preserved.");
      if (await readFile(paths.authJsonPath, "utf8") !== auth) throw new Error("Model selection changed authorization.");
    } finally {
      await rm(homeDir, { recursive: true, force: true });
    }
  },
};
