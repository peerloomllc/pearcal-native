// No user-facing config for v1 (the seeder is enrolled from the phone app, not
// a config form). An empty spec keeps the Config page valid but empty.
import { compat, types as T } from "../deps.ts";

export const getConfig: T.ExpectedExports.getConfig = compat.getConfig({});
