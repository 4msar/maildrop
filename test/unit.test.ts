import { describe, expect, it } from "vitest";
import { isValidMessageId, newMessageId, parseAttachmentIndex } from "../worker/lib/ids";
import { parseRawEmail, sanitizeFilename, truncateUtf8, extractAttachment } from "../worker/lib/mime";
import { checkUsername, randomUsername, usernameFromRecipient } from "../shared/username";
import { registryShardFor } from "../worker/registry";
import { mailDomain, siteOrigin } from "../worker/lib/config";
import { buildEmail } from "./helpers";

describe("checkUsername", () => {
  it.each(["hello", "john.doe", "a_b-c", "abc", "x1y2z3", "a".repeat(32)])("accepts %s", (name) => {
    expect(checkUsername(name)).toEqual({ ok: true, username: name });
  });

  it("normalizes case and whitespace", () => {
    expect(checkUsername("  Hello.World ")).toEqual({ ok: true, username: "hello.world" });
  });

  it.each([
    "", "ab", "a".repeat(33), "-abc", "abc-", ".abc", "abc.", "a..b", "a.-b", "a b", "a/b",
    "../etc", "..%2f", "a\\b", "a@b", "a+b", "ünï", "a\nbc", "<script>",
  ])("rejects %j", (name) => {
    expect(checkUsername(name)).toEqual({ ok: false, reason: "invalid_username" });
  });

  it.each(["admin", "postmaster", "ABUSE", "mailer-daemon", "noreply"])("rejects reserved %s", (name) => {
    expect(checkUsername(name)).toEqual({ ok: false, reason: "reserved_username" });
  });

  it("rejects non-strings", () => {
    expect(checkUsername(42).ok).toBe(false);
    expect(checkUsername(null).ok).toBe(false);
  });

  it("generates valid random usernames", () => {
    for (let i = 0; i < 200; i++) expect(checkUsername(randomUsername()).ok).toBe(true);
  });
});

describe("usernameFromRecipient", () => {
  const d = "mail.example.com";
  it("extracts the local part", () => {
    expect(usernameFromRecipient("Hello@Mail.Example.com", d)).toEqual({ ok: true, username: "hello" });
  });
  it("strips +tags", () => {
    expect(usernameFromRecipient("hello+news@mail.example.com", d)).toEqual({ ok: true, username: "hello" });
  });
  it("rejects other domains", () => {
    expect(usernameFromRecipient("hello@evil.com", d)).toBeNull();
    expect(usernameFromRecipient("hello@sub.mail.example.com", d)).toBeNull();
    expect(usernameFromRecipient("no-at-sign", d)).toBeNull();
  });
  it("flags reserved recipients", () => {
    expect(usernameFromRecipient("postmaster@mail.example.com", d)).toEqual({ ok: false, reason: "reserved_username" });
  });
});

describe("message ids", () => {
  it("round-trips", () => {
    const id = newMessageId();
    expect(isValidMessageId(id)).toBe(true);
    expect(id).toHaveLength(26);
  });
  it("sort by time", () => {
    expect(newMessageId(1000) < newMessageId(2000)).toBe(true);
  });
  it.each(["", "../../x", "ABC", "0".repeat(26) + "/", "zzzzzzzzzzgggggggggggggggg"])("rejects %j", (id) => {
    expect(isValidMessageId(id)).toBe(false);
  });
  it("parses attachment indexes strictly", () => {
    expect(parseAttachmentIndex("0")).toBe(0);
    expect(parseAttachmentIndex("12")).toBe(12);
    expect(parseAttachmentIndex("-1")).toBeNull();
    expect(parseAttachmentIndex("1.5")).toBeNull();
    expect(parseAttachmentIndex("1e3")).toBeNull();
    expect(parseAttachmentIndex("9999")).toBeNull();
  });
});

describe("mime helpers", () => {
  it("truncates on UTF-8 byte boundaries", () => {
    const { value, truncated } = truncateUtf8("€€€", 5); // 3 bytes each
    expect(truncated).toBe(true);
    expect(value).toBe("€");
    expect(truncateUtf8("abc", 5)).toEqual({ value: "abc", truncated: false });
  });

  it("sanitizes filenames", () => {
    expect(sanitizeFilename("../../etc/passwd", 0, "text/plain")).toBe("_.._etc_passwd");
    expect(sanitizeFilename('a"b<c>.txt', 0, "text/plain")).toBe("a_b_c_.txt");
    expect(sanitizeFilename(null, 1, "image/png")).toBe("attachment-2.png");
    expect(sanitizeFilename("...", 0, "application/pdf")).toBe("attachment-1.pdf");
  });

  it("parses text, html and attachments", async () => {
    const raw = new TextEncoder().encode(
      buildEmail({
        to: "x@mail.example.com",
        subject: "Report",
        text: "See attached",
        attachment: { filename: "a.txt", contentType: "text/plain", content: "attachment data" },
      }),
    );
    const parsed = await parseRawEmail(raw, "env@example.com");
    expect(parsed.malformed).toBe(false);
    expect(parsed.subject).toBe("Report");
    expect(parsed.from).toBe("Sender Person <sender@example.com>");
    expect(parsed.text?.trim()).toBe("See attached");
    expect(parsed.html).toContain("<b>body</b>");
    expect(parsed.preview).toBe("See attached");
    expect(parsed.attachments).toEqual([
      { index: 0, filename: "a.txt", mimeType: "text/plain", size: 15, contentId: null, disposition: "attachment" },
    ]);

    const att = await extractAttachment(raw, 0);
    expect(new TextDecoder().decode(att!.content)).toBe("attachment data");
    expect(await extractAttachment(raw, 1)).toBeNull();
  });

  it("does not throw on malformed MIME", async () => {
    // Nesting deeper than maxNestingDepth makes postal-mime reject the parse.
    let raw = "Subject: deep\r\n";
    for (let i = 0; i < 60; i++) raw += `Content-Type: multipart/mixed; boundary="b${i}"\r\n\r\n--b${i}\r\n`;
    const parsed = await parseRawEmail(new TextEncoder().encode(raw), "env@example.com");
    expect(parsed.malformed).toBe(true);
    expect(parsed.from).toBe("env@example.com");
  });

  it("tolerates garbage input", async () => {
    const parsed = await parseRawEmail(new Uint8Array([0, 1, 2, 255, 254]), "env@example.com");
    expect(typeof parsed.subject).toBe("string");
  });
});

describe("registry sharding", () => {
  it("is deterministic and bounded", () => {
    expect(registryShardFor("hello")).toBe(registryShardFor("hello"));
    expect(registryShardFor("hello")).toMatch(/^shard-[0-7]$/);
  });
});

describe("mail domain and site origin", () => {
  const e = (vars: Partial<Env>) => vars as Env;

  it("prefers MAIL_DOMAIN, then the host of SITE_URL, then the fallback host", () => {
    expect(mailDomain(e({ MAIL_DOMAIN: " Mail.Example.com ", SITE_URL: "https://ui.example.com" }), "x.test")).toBe("mail.example.com");
    expect(mailDomain(e({ SITE_URL: "https://UI.example.com/app" }), "x.test")).toBe("ui.example.com");
    expect(mailDomain(e({}), "Maildrop.Workers.dev")).toBe("maildrop.workers.dev");
  });

  it("uses SITE_URL's origin, ignoring an invalid value", () => {
    expect(siteOrigin(e({ SITE_URL: "https://mail.example.com/some/path/" }), "http://localhost:5173")).toBe("https://mail.example.com");
    expect(siteOrigin(e({ SITE_URL: "not a url" }), "http://localhost:5173")).toBe("http://localhost:5173");
    expect(siteOrigin(e({}), "http://localhost:5173")).toBe("http://localhost:5173");
  });
});
