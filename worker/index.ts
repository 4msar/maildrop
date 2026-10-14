// Worker entry point: HTTP (Hono), inbound email, and the backup cleanup cron.

import { app } from "./app";
import { handleEmail, handleOrphanedEmail } from "./email";
import { mailDomain } from "./lib/config";
import { withSiteUrls } from "./lib/html";
import { domainOf } from "./lib/log";
import { runCleanup } from "./scheduled";

export { InboxDurableObject } from "./inbox";
export { InboxRegistry } from "./registry";

export default {
    async fetch(request, env, ctx) {
        if (new URL(request.url).pathname.startsWith("/api/"))
            return app.fetch(request, env, ctx);
        // HTML pages listed in assets.run_worker_first: serve the asset, then fill in absolute URLs.
        return withSiteUrls(await env.ASSETS.fetch(request), env, request.url);
    },

    async email(message, env, _ctx) {
        // Mail for any domain other than the configured mail domain is orphaned. Without
        // MAIL_DOMAIN/SITE_URL the recipient's own domain is used, so nothing is orphaned.
        const recipientDomain = domainOf(message.to);
        if (recipientDomain !== mailDomain(env, "email.message")) {
            await handleOrphanedEmail(message, env);
            return;
        }
        await handleEmail(message, env);
    },

    async scheduled(_controller, env, ctx) {
        ctx.waitUntil(runCleanup(env));
    },
} satisfies ExportedHandler<Env>;
