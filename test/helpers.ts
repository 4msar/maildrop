import { env } from "cloudflare:workers";
import { exports } from "cloudflare:workers";
import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import worker from "../worker/index";

export const DOMAIN = "mail.example.com";

export function buildEmail(opts: {
  from?: string;
  to: string;
  subject?: string;
  text?: string;
  html?: string;
  attachment?: { filename: string; contentType: string; content: string };
}): string {
  const boundary = "BOUNDARY-test-123";
  const lines = [
    `From: Sender Person <${opts.from ?? "sender@example.com"}>`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject ?? "Hello"}`,
    `Date: Sat, 10 Oct 2026 12:00:00 +0000`,
    `Message-ID: <${crypto.randomUUID()}@example.com>`,
    `MIME-Version: 1.0`,
    `Content-Type: multipart/mixed; boundary="${boundary}"`,
    ``,
    `--${boundary}`,
    `Content-Type: multipart/alternative; boundary="${boundary}-alt"`,
    ``,
    `--${boundary}-alt`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    opts.text ?? "Plain body",
    `--${boundary}-alt`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    opts.html ?? "<p>HTML <b>body</b></p>",
    `--${boundary}-alt--`,
  ];
  if (opts.attachment) {
    lines.push(
      `--${boundary}`,
      `Content-Type: ${opts.attachment.contentType}; name="${opts.attachment.filename}"`,
      `Content-Disposition: attachment; filename="${opts.attachment.filename}"`,
      `Content-Transfer-Encoding: base64`,
      ``,
      btoa(opts.attachment.content),
    );
  }
  lines.push(`--${boundary}--`, ``);
  return lines.join("\r\n");
}

export interface FakeEmail extends ForwardableEmailMessage {
  rejected: string | null;
}

export function fakeEmailMessage(from: string, to: string, raw: string | Uint8Array, rawSize?: number): FakeEmail {
  const bytes = typeof raw === "string" ? new TextEncoder().encode(raw) : raw;
  const msg = {
    from,
    to,
    headers: new Headers(),
    raw: new Blob([bytes]).stream(),
    rawSize: rawSize ?? bytes.byteLength,
    canBeForwarded: true,
    rejected: null as string | null,
    setReject(reason: string) {
      msg.rejected = reason;
    },
    forward: async () => {
      throw new Error("not implemented");
    },
    reply: async () => {
      throw new Error("not implemented");
    },
  };
  return msg as unknown as FakeEmail;
}

/** Delivers a message through the Worker's real email() handler. */
export async function deliver(to: string, raw: string | Uint8Array, opts: { from?: string; rawSize?: number } = {}) {
  const msg = fakeEmailMessage(opts.from ?? "sender@example.com", to, raw, opts.rawSize);
  const ctx = createExecutionContext();
  await worker.email!(msg, env, ctx);
  await waitOnExecutionContext(ctx);
  return msg;
}

export function api(path: string, init?: RequestInit): Promise<Response> {
  return exports.default.fetch(new Request(`https://${DOMAIN}${path}`, init));
}

export async function createInbox(username?: string) {
  const res = await api("/api/inboxes", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(username === undefined ? {} : { username }),
  });
  return { res, body: (await res.json()) as any };
}

/** Forces an inbox past its expiry by rewriting expires_at inside the object. */
export async function forceExpire(username: string) {
  const { runInDurableObject } = await import("cloudflare:test");
  await runInDurableObject(env.INBOX.getByName(username), (_instance, state) => {
    state.storage.sql.exec(`UPDATE meta SET expires_at = ? WHERE id = 1`, Date.now() - 1);
  });
}
