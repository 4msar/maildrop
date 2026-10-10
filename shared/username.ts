// Username validation, reserved names, random generation and recipient parsing.

export const USERNAME_MIN = 3;
export const USERNAME_MAX = 32;

// Lowercase letters, digits, and single '.', '_' or '-' separators. Must start and end
// with a letter or digit. This rules out path characters ('/', '\', '%', '..') entirely.
const USERNAME_RE = /^[a-z0-9](?:[a-z0-9]|[._-](?=[a-z0-9]))*$/;

const RESERVED = new Set([
  "abuse", "admin", "administrator", "api", "billing", "contact", "daemon", "dmarc",
  "dns", "ftp", "help", "hostmaster", "imap", "info", "mail", "mailer-daemon",
  "maildrop", "marketing", "noc", "no-reply", "noreply", "null", "postmaster", "pop",
  "privacy", "register", "root", "sales", "security", "smtp", "ssl", "support",
  "sysadmin", "system", "undefined", "usenet", "uucp", "webmaster", "www",
]);

export type UsernameCheck =
  | { ok: true; username: string }
  | { ok: false; reason: "invalid_username" | "reserved_username" };

export function normalizeUsername(input: string): string {
  return input.trim().toLowerCase();
}

export function checkUsername(input: unknown): UsernameCheck {
  if (typeof input !== "string") return { ok: false, reason: "invalid_username" };
  const username = normalizeUsername(input);
  if (username.length < USERNAME_MIN || username.length > USERNAME_MAX) {
    return { ok: false, reason: "invalid_username" };
  }
  if (!USERNAME_RE.test(username)) return { ok: false, reason: "invalid_username" };
  if (RESERVED.has(username)) return { ok: false, reason: "reserved_username" };
  return { ok: true, username };
}

const ADJECTIVES = [
  "amber", "brisk", "calm", "clever", "cosmic", "crisp", "dusty", "eager", "fuzzy",
  "gentle", "happy", "hidden", "icy", "jolly", "lucky", "mellow", "misty", "nimble",
  "quiet", "rapid", "rusty", "shy", "silent", "sunny", "swift", "tidy", "witty",
];
const NOUNS = [
  "badger", "comet", "falcon", "fern", "harbor", "heron", "lantern", "maple", "meadow",
  "otter", "panda", "pebble", "pine", "quartz", "raven", "river", "rocket", "sparrow",
  "tiger", "tulip", "walrus", "willow", "zephyr",
];

function randomInt(max: number): number {
  const buf = new Uint32Array(1);
  crypto.getRandomValues(buf);
  return buf[0] % max;
}

export function randomUsername(): string {
  const adj = ADJECTIVES[randomInt(ADJECTIVES.length)];
  const noun = NOUNS[randomInt(NOUNS.length)];
  const num = String(randomInt(10000)).padStart(4, "0");
  return `${adj}-${noun}-${num}`;
}

/**
 * Extracts the inbox username from an SMTP envelope recipient.
 * Sub-addressing ("name+tag@domain") is delivered to "name".
 * Returns null when the domain does not match or the local part is not a valid username.
 */
export function usernameFromRecipient(recipient: string, domain: string): UsernameCheck | null {
  const addr = recipient.trim().replace(/^<|>$/g, "");
  const at = addr.lastIndexOf("@");
  if (at <= 0) return null;
  const recipientDomain = addr.slice(at + 1).toLowerCase();
  if (recipientDomain !== domain.toLowerCase()) return null;
  const local = addr.slice(0, at).split("+", 1)[0];
  return checkUsername(local);
}
