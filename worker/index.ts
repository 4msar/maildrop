// Worker entry point: HTTP (Hono), inbound email, and the backup cleanup cron.

import { app } from "./app";
import { handleEmail } from "./email";
import { runCleanup } from "./scheduled";

export { InboxDurableObject } from "./inbox";
export { InboxRegistry } from "./registry";

export default {
  fetch: app.fetch,

  async email(message, env, _ctx) {
    await handleEmail(message, env);
  },

  async scheduled(_controller, env, ctx) {
    ctx.waitUntil(runCleanup(env));
  },
} satisfies ExportedHandler<Env>;
