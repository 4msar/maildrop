// HTTP API (Hono). Static assets are served by Workers Static Assets; only /api/* reaches
// this app (see assets.run_worker_first in wrangler.jsonc).

import { Hono, type Context } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ApiError, ApiErrorCode, ConfigResponse } from "../shared/api-types";
import { HEARTBEAT_INTERVAL_MS, INBOX_TTL_MS, getLimits } from "./lib/config";
import { isValidMessageId, parseAttachmentIndex } from "./lib/ids";
import { errorFields, log } from "./lib/log";
import { extractAttachment } from "./lib/mime";
import { checkUsername, randomUsername } from "../shared/username";
import type { InboxFailure } from "./inbox";

type AppEnv = { Bindings: Env; Variables: { username: string } };

export const app = new Hono<AppEnv>().basePath("/api");

const INLINE_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

function fail(c: Context<AppEnv>, status: 400 | 404 | 410 | 413 | 429 | 500, error: ApiErrorCode, message: string) {
  return c.json<ApiError>({ error, message }, status);
}

function failFromInbox(c: Context<AppEnv>, reason: InboxFailure) {
  if (reason === "expired") return fail(c, 410, "inbox_expired", "This inbox has expired.");
  if (reason === "not_found") return fail(c, 404, "not_found", "Not found.");
  return fail(c, 500, "internal_error", "Something went wrong.");
}

function clientKey(c: Context<AppEnv>): string {
  // Anonymous service: the client IP is the only available key. Shared IPs (NAT, VPN)
  // share a budget; the limits below are set generously for that reason.
  return c.req.header("cf-connecting-ip") ?? "unknown";
}

// ---------------------------------------------------------------- middleware

app.use("*", async (c, next) => {
  const started = Date.now();
  await next();
  c.header("Cache-Control", "no-store");
  c.header("X-Content-Type-Options", "nosniff");
  c.header("Referrer-Policy", "no-referrer");
  c.header("X-Frame-Options", "DENY");
  if (!c.res.headers.has("Content-Security-Policy")) {
    c.header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'");
  }
  if (c.res.status >= 500) {
    log("error", "http.error", { method: c.req.method, route: c.req.routePath, status: c.res.status, ms: Date.now() - started });
  }
});

app.use("*", async (c, next) => {
  const { success } = await c.env.API_LIMITER.limit({ key: clientKey(c) });
  if (!success) return fail(c, 429, "rate_limited", "Too many requests. Slow down a little.");
  await next();
});

app.use("/inboxes/:username/*", async (c, next) => {
  const check = checkUsername(c.req.param("username"));
  if (!check.ok) return fail(c, 400, check.reason, "Invalid inbox name.");
  // Route parameters are compared case-insensitively; storage always uses the normalized form.
  c.set("username", check.username);
  await next();
});

app.onError((err, c) => {
  log("error", "http.unhandled", { method: c.req.method, route: c.req.routePath, ...errorFields(err) });
  return fail(c, 500, "internal_error", "Something went wrong.");
});

app.notFound((c) => fail(c, 404, "not_found", "Not found."));

// ---------------------------------------------------------------- routes

app.get("/health", (c) => c.json({ ok: true }));

app.get("/config", (c) => {
  const limits = getLimits(c.env);
  return c.json<ConfigResponse>({
    domain: limits.domain,
    ttlHours: INBOX_TTL_MS / 3_600_000,
    heartbeatIntervalMinutes: HEARTBEAT_INTERVAL_MS / 60_000,
    maxMessageBytes: limits.maxMessageBytes,
  });
});

/** Create or open an inbox. Body: { "username"?: string }. Omit username for a random one. */
app.post("/inboxes", bodyLimit({ maxSize: 1024, onError: (c) => fail(c, 413, "bad_request", "Body too large.") }), async (c) => {
  const { success } = await c.env.CREATE_LIMITER.limit({ key: clientKey(c) });
  if (!success) return fail(c, 429, "rate_limited", "Too many inboxes created. Try again in a minute.");

  let body: { username?: unknown } = {};
  if (c.req.header("content-type")?.includes("application/json")) {
    try {
      body = (await c.req.json()) ?? {};
    } catch {
      return fail(c, 400, "bad_request", "Invalid JSON body.");
    }
  }

  let username: string;
  if (body.username === undefined || body.username === null || body.username === "") {
    username = randomUsername();
  } else {
    const check = checkUsername(body.username);
    if (!check.ok) {
      return fail(
        c,
        400,
        check.reason,
        check.reason === "reserved_username"
          ? "That name is reserved. Please choose another."
          : "Use 3-32 characters: lowercase letters, digits, and single '.', '_' or '-' between them.",
      );
    }
    username = check.username;
  }

  const inbox = await c.env.INBOX.getByName(username).initialize(username);
  return c.json({ inbox }, 200);
});

app.get("/inboxes/:username", async (c) => {
  const username = c.get("username");
  const res = await c.env.INBOX.getByName(username).getInbox(username);
  return res.ok ? c.json({ inbox: res.inbox }) : failFromInbox(c, res.reason);
});

app.post("/inboxes/:username/heartbeat", async (c) => {
  const username = c.get("username");
  const res = await c.env.INBOX.getByName(username).heartbeat(username);
  return res.ok ? c.json({ inbox: res.inbox }) : failFromInbox(c, res.reason);
});

app.get("/inboxes/:username/messages", async (c) => {
  const username = c.get("username");
  const res = await c.env.INBOX.getByName(username).listEmails(username);
  return res.ok ? c.json({ inbox: res.inbox, messages: res.messages }) : failFromInbox(c, res.reason);
});

app.get("/inboxes/:username/messages/:id", async (c) => {
  const username = c.get("username");
  const id = c.req.param("id");
  if (!isValidMessageId(id)) return fail(c, 400, "invalid_message_id", "Invalid message id.");
  const res = await c.env.INBOX.getByName(username).getEmail(username, id);
  return res.ok ? c.json({ message: res.message }) : failFromInbox(c, res.reason);
});

app.delete("/inboxes/:username/messages/:id", async (c) => {
  const username = c.get("username");
  const id = c.req.param("id");
  if (!isValidMessageId(id)) return fail(c, 400, "invalid_message_id", "Invalid message id.");
  const res = await c.env.INBOX.getByName(username).deleteEmail(username, id);
  return res.ok ? c.json({ deleted: true }) : failFromInbox(c, res.reason);
});

/** Download the original message as .eml. Always served as a download, never rendered. */
app.get("/inboxes/:username/messages/:id/raw", async (c) => {
  const username = c.get("username");
  const id = c.req.param("id");
  if (!isValidMessageId(id)) return fail(c, 400, "invalid_message_id", "Invalid message id.");
  const res = await c.env.INBOX.getByName(username).getRawEmail(username, id);
  if (!res.ok) return failFromInbox(c, res.reason);
  return new Response(res.raw, {
    headers: {
      "Content-Type": "message/rfc822",
      "Content-Disposition": `attachment; filename="${id}.eml"`,
      "Content-Length": String(res.size),
      "Content-Security-Policy": "default-src 'none'; sandbox",
    },
  });
});

/**
 * Download an attachment by its index in the parsed message. Storage paths are never
 * exposed: the attachment is re-extracted from the stored raw message on demand.
 * `?inline=1` serves raster images (png/jpeg/gif/webp) inline for previews; everything
 * else is always an octet-stream download.
 */
app.get("/inboxes/:username/messages/:id/attachments/:index", async (c) => {
  const username = c.get("username");
  const id = c.req.param("id");
  const index = parseAttachmentIndex(c.req.param("index"));
  if (!isValidMessageId(id)) return fail(c, 400, "invalid_message_id", "Invalid message id.");
  if (index === null) return fail(c, 400, "invalid_attachment", "Invalid attachment index.");

  const res = await c.env.INBOX.getByName(username).getRawEmail(username, id);
  if (!res.ok) return failFromInbox(c, res.reason);
  const att = await extractAttachment(res.raw, index);
  if (!att) return fail(c, 404, "not_found", "Attachment not found.");

  const inline = c.req.query("inline") === "1" && INLINE_IMAGE_TYPES.has(att.info.mimeType);
  const encoded = encodeURIComponent(att.info.filename);
  const asciiName = att.info.filename.replace(/[^\x20-\x7e]/g, "_");
  return new Response(att.content, {
    headers: {
      "Content-Type": inline ? att.info.mimeType : "application/octet-stream",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename="${asciiName}"; filename*=UTF-8''${encoded}`,
      "Content-Length": String(att.content.byteLength),
      "Content-Security-Policy": "default-src 'none'; sandbox",
      // Allow the sandboxed (opaque-origin) HTML preview iframe to load inline images.
      ...(inline ? { "Cross-Origin-Resource-Policy": "cross-origin" } : {}),
    },
  });
});
