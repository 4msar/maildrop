// Optional secrets/vars that are not declared in wrangler.jsonc, so `wrangler types` does
// not generate them. Set them with `wrangler secret put` (or in .dev.vars locally).

interface Env {
  /** Zone that receives mail. With CF_TOKEN, enables per-address Email Routing rules. */
  ZONE_ID?: string;
  /** API token with "Zone > Email Routing Rules > Edit" on ZONE_ID. */
  CF_TOKEN?: string;
  /** Worker that routing rules send mail to. Defaults to "maildrop". */
  EMAIL_WORKER_NAME?: string;
  /** Bearer token for POST /api/admin/cleanup. The route is disabled (404) when unset. */
  ADMIN_TOKEN?: string;
}
