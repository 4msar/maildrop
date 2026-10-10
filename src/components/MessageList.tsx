import type { MessageSummary } from "../../shared/api-types";
import { formatDateTime, formatRelative, senderName } from "../lib/format";
import { PaperclipIcon } from "./icons";

interface Props {
  messages: MessageSummary[];
  selectedId: string | null;
  onSelect: (id: string) => void;
  now: number;
}

export function MessageList({ messages, selectedId, onSelect, now }: Props) {
  if (messages.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 px-6 py-16 text-center">
        <span className="relative flex size-3">
          <span className="absolute inline-flex size-full animate-ping rounded-full bg-brand-500 opacity-60" />
          <span className="relative inline-flex size-3 rounded-full bg-brand-500" />
        </span>
        <p className="font-medium">Waiting for incoming mail…</p>
        <p className="max-w-xs text-sm text-slate-500 dark:text-slate-400">
          New messages appear here automatically. Send something to this address to try it.
        </p>
      </div>
    );
  }

  return (
    <ul className="divide-y divide-slate-100 dark:divide-slate-800" aria-label="Messages">
      {messages.map((m) => {
        const active = m.id === selectedId;
        return (
          <li key={m.id}>
            <button
              type="button"
              onClick={() => onSelect(m.id)}
              aria-current={active ? "true" : undefined}
              className={`block w-full px-4 py-3 text-left transition ${
                active
                  ? "bg-brand-50 dark:bg-brand-800/20"
                  : "hover:bg-slate-50 dark:hover:bg-slate-800/50"
              }`}
            >
              <div className="flex items-baseline justify-between gap-3">
                <span className="truncate text-sm font-semibold">{senderName(m.from)}</span>
                <time
                  className="shrink-0 text-xs text-slate-500 dark:text-slate-400"
                  dateTime={new Date(m.receivedAt).toISOString()}
                  title={formatDateTime(m.receivedAt)}
                >
                  {formatRelative(m.receivedAt, now)}
                </time>
              </div>
              <div className="mt-0.5 flex items-center gap-1.5">
                <span className="truncate text-sm">{m.subject || "(no subject)"}</span>
                {m.attachmentCount > 0 && (
                  <PaperclipIcon className="size-3.5 shrink-0 text-slate-400" aria-label="Has attachments" />
                )}
              </div>
              {m.preview && (
                <p className="mt-0.5 truncate text-xs text-slate-500 dark:text-slate-400">{m.preview}</p>
              )}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
