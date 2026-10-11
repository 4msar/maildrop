// End-to-end through the Worker's real fetch() and email() handlers.

import { describe, expect, it } from "vitest";
import { api, buildEmail, createInbox, deliver } from "./helpers";

const bodyText = async (res: Response) => new TextDecoder().decode(await res.arrayBuffer());

const addr = (u: string) => `${u}@maildrop.msar.me`;

describe("inbox creation", () => {
  it("creates a random inbox", async () => {
    const { res, body } = await createInbox();
    expect(res.status).toBe(200);
    expect(body.inbox.address).toMatch(/^[a-z]+-[a-z]+-\d{4}@maildrop\.msar\.me$/);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
  });

  it("creates a custom inbox, normalizing case", async () => {
    const { res, body } = await createInbox("My.Custom");
    expect(res.status).toBe(200);
    expect(body.inbox.username).toBe("my.custom");
  });

  it("rejects invalid and reserved names", async () => {
    expect((await createInbox("a/b")).res.status).toBe(400);
    expect((await createInbox("x")).body.error).toBe("invalid_username");
    expect((await createInbox("admin")).body.error).toBe("reserved_username");
  });

  it("rejects oversized and malformed bodies", async () => {
    const big = await api("/api/inboxes", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "a".repeat(5000) }),
    });
    expect(big.status).toBe(413);
    const bad = await api("/api/inboxes", { method: "POST", headers: { "content-type": "application/json" }, body: "{" });
    expect(bad.status).toBe(400);
  });

  it("heartbeat endpoint returns 404 for unknown inboxes", async () => {
    const res = await api("/api/inboxes/nobody-here/heartbeat", { method: "POST" });
    expect(res.status).toBe(404);
  });
});

describe("inbound email", () => {
  it("stores, lists, reads, downloads and deletes a message", async () => {
    await createInbox("e2e-flow");
    const msg = await deliver(
      addr("e2e-flow"),
      buildEmail({
        to: addr("e2e-flow"),
        subject: "Your code",
        text: "Code: 1234",
        html: `<p onclick="x()">Code: <b>1234</b></p><script>alert(1)</script>`,
        attachment: { filename: "invoice.pdf", contentType: "application/pdf", content: "%PDF-fake" },
      }),
    );
    expect(msg.rejected).toBeNull();

    const list = await (await api("/api/inboxes/e2e-flow/messages")).json<any>();
    expect(list.messages).toHaveLength(1);
    const summary = list.messages[0];
    expect(summary).toMatchObject({ subject: "Your code", from: "Sender Person <sender@example.com>", attachmentCount: 1 });
    expect(summary.preview).toBe("Code: 1234");

    const detail = (await (await api(`/api/inboxes/e2e-flow/messages/${summary.id}`)).json<any>()).message;
    expect(detail.text.trim()).toBe("Code: 1234");
    // HTML is stored as received; it is sanitized and sandboxed by the client.
    expect(detail.html).toContain("<b>1234</b>");
    expect(detail.attachments[0]).toMatchObject({ index: 0, filename: "invoice.pdf", mimeType: "application/pdf" });
    expect(detail.headers.some((h: any) => h.key === "Subject")).toBe(true);

    const raw = await api(`/api/inboxes/e2e-flow/messages/${summary.id}/raw`);
    expect(raw.status).toBe(200);
    expect(raw.headers.get("content-type")).toBe("message/rfc822");
    expect(raw.headers.get("content-disposition")).toContain("attachment");
    expect(await bodyText(raw)).toContain("Subject: Your code");

    const att = await api(`/api/inboxes/e2e-flow/messages/${summary.id}/attachments/0?inline=1`);
    expect(att.status).toBe(200);
    // PDFs are never served inline or with their own content type.
    expect(att.headers.get("content-type")).toBe("application/octet-stream");
    expect(att.headers.get("content-disposition")).toMatch(/^attachment; filename="invoice.pdf"/);
    expect(att.headers.get("content-security-policy")).toContain("sandbox");
    expect(await bodyText(att)).toBe("%PDF-fake");

    expect((await api(`/api/inboxes/e2e-flow/messages/${summary.id}/attachments/5`)).status).toBe(404);

    const del = await api(`/api/inboxes/e2e-flow/messages/${summary.id}`, { method: "DELETE" });
    expect(del.status).toBe(200);
    expect((await api(`/api/inboxes/e2e-flow/messages/${summary.id}`)).status).toBe(404);
    const after = await (await api("/api/inboxes/e2e-flow/messages")).json<any>();
    expect(after.messages).toHaveLength(0);
    expect(after.inbox.totalBytes).toBe(0);
  });

  it("serves raster image attachments inline only when asked", async () => {
    await createInbox("e2e-image");
    await deliver(
      addr("e2e-image"),
      buildEmail({ to: addr("e2e-image"), attachment: { filename: "p.png", contentType: "image/png", content: "PNGDATA" } }),
    );
    const { messages } = await (await api("/api/inboxes/e2e-image/messages")).json<any>();
    const inline = await api(`/api/inboxes/e2e-image/messages/${messages[0].id}/attachments/0?inline=1`);
    expect(inline.headers.get("content-type")).toBe("image/png");
    expect(inline.headers.get("content-disposition")).toMatch(/^inline/);
    const download = await api(`/api/inboxes/e2e-image/messages/${messages[0].id}/attachments/0`);
    expect(download.headers.get("content-type")).toBe("application/octet-stream");
  });

  it("delivers +tag addresses to the base inbox", async () => {
    await createInbox("e2e-tag");
    const msg = await deliver("e2e-tag+shop@maildrop.msar.me", buildEmail({ to: "e2e-tag+shop@maildrop.msar.me" }));
    expect(msg.rejected).toBeNull();
    const { messages } = await (await api("/api/inboxes/e2e-tag/messages")).json<any>();
    expect(messages).toHaveLength(1);
  });

  it("rejects mail for unknown, invalid, reserved and foreign recipients", async () => {
    const raw = buildEmail({ to: "x" });
    expect((await deliver(addr("does-not-exist"), raw)).rejected).toBe("Mailbox does not exist");
    expect((await deliver(addr("../etc"), raw)).rejected).toBe("Mailbox does not exist");
    expect((await deliver(addr("postmaster"), raw)).rejected).toBe("Mailbox does not exist");
    expect((await deliver("someone@other.example", raw)).rejected).toBe("Mailbox does not exist");
  });

  it("rejects oversized messages by declared and actual size", async () => {
    await createInbox("e2e-big");
    const big = buildEmail({ to: addr("e2e-big"), text: "x".repeat(1_200_000) });
    expect((await deliver(addr("e2e-big"), big)).rejected).toBe("Message too large");
    // rawSize lies: the stream is still capped while reading.
    expect((await deliver(addr("e2e-big"), big, { rawSize: 100 })).rejected).toBe("Message too large");
  });

  it("stores malformed MIME and still serves the raw message", async () => {
    await createInbox("e2e-malformed");
    let raw = "Subject: deep\r\n";
    for (let i = 0; i < 60; i++) raw += `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`;
    expect((await deliver(addr("e2e-malformed"), raw)).rejected).toBeNull();
    const { messages } = await (await api("/api/inboxes/e2e-malformed/messages")).json<any>();
    expect(messages[0].subject).toBe("(unparseable message)");
    const detail = (await (await api(`/api/inboxes/e2e-malformed/messages/${messages[0].id}`)).json<any>()).message;
    expect(detail.malformed).toBe(true);
    expect((await api(`/api/inboxes/e2e-malformed/messages/${messages[0].id}/raw`)).status).toBe(200);
  });

  it("stores large messages across multiple chunks and reassembles them exactly", async () => {
    await createInbox("e2e-chunks");
    // Test config caps messages at 1 MiB; RAW_CHUNK_BYTES is 1 MiB, so craft just under it
    // and verify byte-exact round trip.
    const body = Array.from({ length: 15000 }, (_, i) => `line ${i} ${"z".repeat(50)}`).join("\r\n");
    const raw = buildEmail({ to: addr("e2e-chunks"), text: body });
    expect(new TextEncoder().encode(raw).byteLength).toBeLessThan(1024 * 1024);
    expect((await deliver(addr("e2e-chunks"), raw)).rejected).toBeNull();
    const { messages } = await (await api("/api/inboxes/e2e-chunks/messages")).json<any>();
    const download = await api(`/api/inboxes/e2e-chunks/messages/${messages[0].id}/raw`);
    expect(await bodyText(download)).toBe(raw);
  });

  it("enforces the per-inbox message quota", async () => {
    await createInbox("e2e-quota");
    const raw = buildEmail({ to: addr("e2e-quota") });
    // MAX_MESSAGES_PER_INBOX is 5 in vitest.config.ts.
    for (let i = 0; i < 5; i++) expect((await deliver(addr("e2e-quota"), raw)).rejected).toBeNull();
    expect((await deliver(addr("e2e-quota"), raw)).rejected).toBe("Mailbox full");
  });
});

describe("access control and path handling", () => {
  it("rejects invalid usernames and message ids in paths", async () => {
    expect((await api("/api/inboxes/..%2F..%2Fx/messages")).status).toBe(400);
    expect((await api("/api/inboxes/ADMIN/messages")).status).toBe(400);
    expect((await api("/api/inboxes/valid-name/messages/..%2Fraw")).status).toBe(400);
    expect((await api("/api/inboxes/valid-name/messages/0000000000aaaaaaaaaaaaaaaa/attachments/-1")).status).toBe(400);
  });

  it("cannot read another inbox's message by id", async () => {
    await createInbox("e2e-alice");
    await createInbox("e2e-bob");
    await deliver(addr("e2e-alice"), buildEmail({ to: addr("e2e-alice"), subject: "secret" }));
    const { messages } = await (await api("/api/inboxes/e2e-alice/messages")).json<any>();
    const res = await api(`/api/inboxes/e2e-bob/messages/${messages[0].id}`);
    expect(res.status).toBe(404);
  });

  it("returns JSON 404 for unknown API routes", async () => {
    const res = await api("/api/nope");
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: "not_found" });
  });
});

describe("inbox deletion", () => {
  it("deletes the inbox and its messages, then rejects mail to it", async () => {
    await createInbox("to-delete");
    expect((await deliver(addr("to-delete"), buildEmail({ to: addr("to-delete") }))).rejected).toBeNull();

    const res = await api("/api/inboxes/to-delete", { method: "DELETE" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true });

    expect((await api("/api/inboxes/to-delete/messages")).status).toBe(404);
    expect((await api("/api/inboxes/to-delete/heartbeat", { method: "POST" })).status).toBe(404);
    expect((await deliver(addr("to-delete"), buildEmail({ to: addr("to-delete") }))).rejected).not.toBeNull();
  });

  it("can be reopened afterwards as a fresh, empty inbox", async () => {
    await createInbox("reopen-me");
    await deliver(addr("reopen-me"), buildEmail({ to: addr("reopen-me") }));
    await api("/api/inboxes/reopen-me", { method: "DELETE" });

    const { body } = await createInbox("reopen-me");
    expect(body.inbox.messageCount).toBe(0);
    const list = (await (await api("/api/inboxes/reopen-me/messages")).json()) as any;
    expect(list.messages).toEqual([]);
  });

  it("returns 404 for unknown inboxes and 400 for invalid names", async () => {
    expect((await api("/api/inboxes/never-existed", { method: "DELETE" })).status).toBe(404);
    expect((await api("/api/inboxes/a..b", { method: "DELETE" })).status).toBe(400);
  });
});
