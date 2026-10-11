import { useCallback, useEffect, useState } from "react";
import type { MessageDetail } from "../../shared/api-types";
import { ApiRequestError, api } from "../lib/api";
import { formatBytes, formatDateTime } from "../lib/format";
import { HtmlPreview } from "./HtmlPreview";
import { ArrowLeftIcon, ChevronDownIcon, DownloadIcon, PaperclipIcon, TrashIcon } from "./icons";

type Tab = "html" | "text" | "headers";

const PREVIEWABLE_IMAGES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);

interface Props {
  username: string;
  messageId: string;
  onBack: () => void;
  onDeleted: (id: string) => void;
  onGone: () => void;
}

export function MessageView({ username, messageId, onBack, onDeleted, onGone }: Props) {
  const [message, setMessage] = useState<MessageDetail | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>("html");
  const [deleting, setDeleting] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  useEffect(() => {
    // The component is keyed by message id, so state starts fresh for each message.
    let cancelled = false;
    api
      .getMessage(username, messageId)
      .then(({ message }) => {
        if (cancelled) return;
        setMessage(message);
        setTab(message.html ? "html" : "text");
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (err instanceof ApiRequestError && err.status === 410) return onGone();
        setError(err instanceof Error ? err.message : "Could not load this message.");
      });
    return () => {
      cancelled = true;
    };
  }, [username, messageId, onGone]);

  const attachmentUrl = useCallback(
    (index: number) => api.attachmentUrl(username, messageId, index, true),
    [username, messageId],
  );

  async function remove() {
    setDeleting(true);
    try {
      await api.deleteMessage(username, messageId);
      onDeleted(messageId);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not delete this message.");
      setDeleting(false);
    }
  }

  const backButton = (
    <button
      type="button"
      onClick={onBack}
      aria-label="Back to inbox"
      title="Back to inbox"
      className="inline-flex shrink-0 items-center rounded-md p-1.5 text-slate-600 hover:bg-slate-100 lg:hidden dark:text-slate-300 dark:hover:bg-slate-800"
    >
      <ArrowLeftIcon className="size-4" />
    </button>
  );

  if (error) {
    return (
      <div className="p-6">
        {backButton}
        <p role="alert" className="mt-4 rounded-lg bg-red-50 p-4 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-300">
          {error}
        </p>
      </div>
    );
  }

  if (!message) {
    return (
      <div className="animate-pulse space-y-3 p-6" aria-busy="true" aria-label="Loading message">
        <div className="h-6 w-2/3 rounded bg-slate-200 dark:bg-slate-800" />
        <div className="h-4 w-1/3 rounded bg-slate-200 dark:bg-slate-800" />
        <div className="h-64 rounded bg-slate-100 dark:bg-slate-800/60" />
      </div>
    );
  }

  const tabs: Array<{ id: Tab; label: string; show: boolean }> = [
    { id: "html", label: "HTML", show: message.html !== null },
    { id: "text", label: "Text", show: true },
    { id: "headers", label: "Headers", show: true },
  ];

  return (
    <article className="flex h-full flex-col">
      <header className="border-b border-slate-200 px-3 py-2 sm:px-4 dark:border-slate-800">
        <div className="flex items-center gap-1.5">
          {backButton}
          <button
            type="button"
            onClick={() => setShowDetails((v) => !v)}
            aria-expanded={showDetails}
            aria-controls="message-details"
            title={showDetails ? "Hide details" : "Show details"}
            className="group flex min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-left hover:bg-slate-100 dark:hover:bg-slate-800"
          >
            <h2 className={`min-w-0 text-base font-semibold sm:text-lg ${showDetails ? "break-words" : "truncate"}`}>
              {message.subject || "(no subject)"}
            </h2>
            {!showDetails && message.attachments.length > 0 && (
              <span className="inline-flex shrink-0 items-center gap-0.5 text-xs text-slate-500 dark:text-slate-400">
                <PaperclipIcon className="size-3.5" />
                {message.attachments.length}
              </span>
            )}
            <ChevronDownIcon
              className={`size-4 shrink-0 text-slate-500 transition-transform group-hover:text-slate-800 dark:text-slate-400 dark:group-hover:text-slate-200 ${showDetails ? "rotate-180" : ""}`}
            />
            <span className="sr-only">{showDetails ? "Hide details" : "Show details"}</span>
          </button>
          <div className="flex shrink-0 gap-1.5">
            <a
              href={api.rawUrl(username, messageId)}
              download
              title="Download .eml"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2 py-1.5 text-sm hover:bg-slate-50 sm:px-3 dark:border-slate-700 dark:hover:bg-slate-800"
            >
              <DownloadIcon className="size-4" />
              <span className="hidden sm:inline">.eml</span>
            </a>
            <button
              type="button"
              onClick={remove}
              disabled={deleting}
              aria-label="Delete message"
              title="Delete message"
              className="inline-flex items-center gap-1.5 rounded-lg border border-slate-300 px-2 py-1.5 text-sm text-red-600 hover:bg-red-50 disabled:opacity-50 sm:px-3 dark:border-slate-700 dark:text-red-400 dark:hover:bg-red-950/40"
            >
              <TrashIcon className="size-4" />
              <span className="hidden sm:inline">{deleting ? "Deleting…" : "Delete"}</span>
            </button>
          </div>
        </div>

        {showDetails && (
          <div id="message-details" className="px-1.5 pt-1 pb-2">
            <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-0.5 text-sm">
              <dt className="text-slate-500 dark:text-slate-400">From</dt>
              <dd className="break-all">{message.from}</dd>
              {message.to && (
                <>
                  <dt className="text-slate-500 dark:text-slate-400">To</dt>
                  <dd className="break-all">{message.to}</dd>
                </>
              )}
              {message.cc && (
                <>
                  <dt className="text-slate-500 dark:text-slate-400">Cc</dt>
                  <dd className="break-all">{message.cc}</dd>
                </>
              )}
              <dt className="text-slate-500 dark:text-slate-400">Received</dt>
              <dd>{formatDateTime(message.receivedAt)}</dd>
            </dl>

            {message.attachments.length > 0 && (
              <ul className="mt-3 flex flex-wrap gap-2" aria-label="Attachments">
                {message.attachments.map((a) => (
                  <li key={a.index}>
                    <a
                      href={api.attachmentUrl(username, messageId, a.index)}
                      download={a.filename}
                      className="flex max-w-xs items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm hover:border-brand-500 dark:border-slate-700 dark:bg-slate-800/60"
                    >
                      {PREVIEWABLE_IMAGES.has(a.mimeType) ? (
                        <img
                          src={api.attachmentUrl(username, messageId, a.index, true)}
                          alt=""
                          className="size-8 rounded object-cover"
                          loading="lazy"
                        />
                      ) : (
                        <PaperclipIcon className="size-4 shrink-0 text-slate-400" />
                      )}
                      <span className="truncate">{a.filename}</span>
                      <span className="shrink-0 text-xs text-slate-500">{formatBytes(a.size)}</span>
                    </a>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}

        {message.malformed && (
          <p className="mx-1.5 mt-1 mb-1 rounded-lg bg-amber-50 p-2.5 text-sm text-amber-900 dark:bg-amber-950/40 dark:text-amber-200">
            This message could not be parsed. Download the .eml file to inspect it.
          </p>
        )}
      </header>

      <div role="tablist" className="flex gap-1 border-b border-slate-200 px-4 dark:border-slate-800">
        {tabs
          .filter((t) => t.show)
          .map((t) => (
            <button
              key={t.id}
              role="tab"
              type="button"
              aria-selected={tab === t.id}
              onClick={() => setTab(t.id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm font-medium transition ${
                tab === t.id
                  ? "border-brand-600 text-brand-700 dark:text-brand-500"
                  : "border-transparent text-slate-500 hover:text-slate-800 dark:hover:text-slate-200"
              }`}
            >
              {t.label}
            </button>
          ))}
      </div>

      <div className="min-h-0 flex-1 overflow-auto" role="tabpanel">
        {tab === "html" && message.html !== null && (
          <HtmlPreview html={message.html} attachments={message.attachments} attachmentUrl={attachmentUrl} />
        )}
        {tab === "text" &&
          (message.text ? (
            // React escapes text content, so this is always rendered as plain text.
            <pre className="p-4 font-sans text-sm whitespace-pre-wrap break-words sm:p-6">{message.text}</pre>
          ) : (
            <p className="p-6 text-sm text-slate-500">This message has no plain-text part.</p>
          ))}
        {tab === "headers" && (
          <table className="w-full text-left font-mono text-xs">
            <tbody>
              {message.headers.map((h, i) => (
                <tr key={i} className="border-b border-slate-100 align-top dark:border-slate-800">
                  <th className="py-1.5 pr-3 pl-4 font-semibold whitespace-nowrap">{h.key}</th>
                  <td className="py-1.5 pr-4 break-all">{h.value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {(message.textTruncated || message.htmlTruncated) && (
          <p className="p-4 text-xs text-slate-500">
            This message body was truncated for display. Download the .eml file for the full content.
          </p>
        )}
      </div>
    </article>
  );
}
