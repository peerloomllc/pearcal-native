import { types as T, healthUtil } from "../deps.ts";

// The dashboard host binds 8731 inside the container; the internal address is
// <pkg-id>.embassy. A 2xx from the root page means the worklet host is up.
export const health: T.ExpectedExports.health = {
  async "web-ui"(effects, duration) {
    return healthUtil
      .checkWebUrl("http://pearcal-seeder.embassy:8731")(effects, duration)
      .catch(healthUtil.catchError(effects));
  },
};
