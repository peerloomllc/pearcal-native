// Bundle scripts/embassy.ts (+ its imports) into the single embassy.js the
// s9pk ships. Invoked by `make scripts/embassy.js`.
import { bundle } from "https://deno.land/x/emit@0.40.0/mod.ts";

const result = await bundle("scripts/embassy.ts");

await Deno.writeTextFile("scripts/embassy.js", result.code);
