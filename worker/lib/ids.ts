// Message identifiers: 10 base-36 timestamp characters followed by 16 random hex characters.
// The format is validated on every API request, so ids can never carry path segments.

const MESSAGE_ID_RE = /^[0-9a-z]{10}[0-9a-f]{16}$/;

export function newMessageId(now = Date.now()): string {
  const time = now.toString(36).padStart(10, "0");
  const bytes = new Uint8Array(8);
  crypto.getRandomValues(bytes);
  const rand = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return time + rand;
}

export function isValidMessageId(id: unknown): id is string {
  return typeof id === "string" && MESSAGE_ID_RE.test(id);
}

/** Attachment indexes are small non-negative integers in decimal form. */
export function parseAttachmentIndex(value: string): number | null {
  if (!/^\d{1,3}$/.test(value)) return null;
  return Number.parseInt(value, 10);
}
