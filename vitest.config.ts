import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        // Generous limits so the suite is not throttled by its own requests.
        ratelimits: {
          API_LIMITER: { namespace_id: "91001", simple: { limit: 10000, period: 60 } },
          CREATE_LIMITER: { namespace_id: "91002", simple: { limit: 1000, period: 60 } },
        },
        bindings: {
          MAX_MESSAGE_BYTES: "1048576",
          MAX_MESSAGES_PER_INBOX: "5",
          // Never call the real Cloudflare API from tests, even when .dev.vars has credentials.
          ZONE_ID: "",
          CF_TOKEN: "",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
