// Writes src/schema.gen.ts, the TypeScript types of the HOLO API, from openapi.json (WP 3.1).
// openapi.json is written by the server's contract test (UPDATE_API=1 pnpm --filter @viewer/server test),
// so the order after an API change is: server test with UPDATE_API=1, then this.
//   node scripts/generate.mjs          writes the file
//   node scripts/generate.mjs --check  fails if the file is out of date
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import openapiTS, { astToString } from "openapi-typescript";

const here = (p) => fileURLToPath(new URL(p, import.meta.url));

export async function generate() {
  const spec = JSON.parse(readFileSync(here("../openapi.json"), "utf8"));
  const ast = await openapiTS(spec, { alphabetize: true, exportType: true });
  return `// Generated from openapi.json by scripts/generate.mjs. Do not edit by hand.\n\n${astToString(ast)}`;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const out = here("../src/schema.gen.ts");
  const text = await generate();
  if (process.argv.includes("--check")) {
    if (readFileSync(out, "utf8") !== text) {
      console.error("src/schema.gen.ts is out of date: run `pnpm --filter @viewer/api-client generate`.");
      process.exit(1);
    }
  } else writeFileSync(out, text);
}
