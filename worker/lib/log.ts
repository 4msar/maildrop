// Structured JSON logging. Workers Logs (observability) indexes JSON fields.
// Never pass message bodies, subjects or full addresses here: only ids, sizes and codes.

type Level = "info" | "warn" | "error";

export function log(level: Level, event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ level, event, ...fields });
  if (level === "error") console.error(line);
  else if (level === "warn") console.warn(line);
  else console.log(line);
}

export function errorFields(err: unknown): Record<string, unknown> {
  if (err instanceof Error) return { errorName: err.name, errorMessage: err.message.slice(0, 300) };
  return { errorMessage: String(err).slice(0, 300) };
}

/** Domain part only, so logs can show traffic sources without exposing full addresses. */
export function domainOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(at + 1).toLowerCase().slice(0, 253) : "invalid";
}
