import { buildSkillsCatalog, SkillsCatalogError } from "../src/skills/catalog-builder.js";

try {
  const result = await buildSkillsCatalog();
  for (const warning of result.warnings) {
    console.warn(`Warning: ${warning}`);
  }
  console.log(`Generated ${result.catalog.skills.length} skills`);
  console.log(`Wrote ${result.outputPaths.skills}`);
  console.log(`Wrote ${result.outputPaths.meta}`);
} catch (error) {
  if (error instanceof SkillsCatalogError) {
    console.error(error.message);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
