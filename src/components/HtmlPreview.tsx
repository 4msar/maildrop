import DOMPurify from "dompurify";
import { useMemo, useState } from "react";
import type { AttachmentInfo } from "../../shared/api-types";

interface Props {
  html: string;
  attachments: AttachmentInfo[];
  attachmentUrl: (index: number) => string;
}

const REMOTE_RE = /^(https?:)?\/\//i;

/**
 * Renders email HTML in three layers:
 * 1. DOMPurify strips scripts, event handlers, forms, frames and other active content.
 * 2. The iframe is sandboxed without allow-scripts or allow-same-origin, so even
 *    sanitizer bypasses cannot run script or touch this origin's cookies/storage.
 * 3. A CSP inside the document blocks every network request except inline (cid:)
 *    images served by our API. Remote images load only after an explicit click.
 */
export function HtmlPreview({ html, attachments, attachmentUrl }: Props) {
  const [allowRemote, setAllowRemote] = useState(false);

  const { srcDoc, hasRemote } = useMemo(() => {
    const cidMap = new Map<string, string>();
    for (const a of attachments) {
      if (a.contentId) cidMap.set(a.contentId.toLowerCase(), attachmentUrl(a.index));
    }

    const fragment = DOMPurify.sanitize(html, {
      RETURN_DOM_FRAGMENT: true,
      FORCE_BODY: true,
      FORBID_TAGS: ["form", "input", "button", "textarea", "select", "option", "iframe", "frame", "frameset",
        "object", "embed", "applet", "base", "meta", "link", "script", "noscript", "svg", "math", "template"],
      FORBID_ATTR: ["action", "formaction", "ping", "srcset", "autofocus"],
    });

    let remote = false;
    fragment.querySelectorAll<HTMLElement>("[src], [background], [style]").forEach((el) => {
      for (const attr of ["src", "background"]) {
        const value = el.getAttribute(attr)?.trim();
        if (!value) continue;
        if (value.toLowerCase().startsWith("cid:")) {
          const url = cidMap.get(value.slice(4).replace(/^<|>$/g, "").toLowerCase());
          if (url) el.setAttribute(attr, url);
          else el.removeAttribute(attr);
        } else if (REMOTE_RE.test(value)) {
          remote = true;
        }
      }
      if (/url\s*\(/i.test(el.getAttribute("style") ?? "")) remote = true;
    });
    fragment.querySelectorAll("style").forEach((s) => {
      if (/url\s*\(|@import/i.test(s.textContent ?? "")) remote = true;
    });
    fragment.querySelectorAll("a[href]").forEach((a) => {
      a.setAttribute("target", "_blank");
      a.setAttribute("rel", "noopener noreferrer nofollow");
    });

    const container = document.createElement("div");
    container.appendChild(fragment);

    const origin = window.location.origin;
    const imgSrc = allowRemote ? `data: ${origin} https: http:` : `data: ${origin}`;
    const csp = `default-src 'none'; img-src ${imgSrc}; style-src 'unsafe-inline'${allowRemote ? " https:" : ""}; font-src data:${allowRemote ? " https:" : ""}; form-action 'none'`;

    const doc = `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="referrer" content="no-referrer">
<base target="_blank">
<style>html,body{margin:0;padding:0;background:#fff;color:#111}body{padding:16px;font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;overflow-wrap:anywhere}img{max-width:100%;height:auto}table{max-width:100%}</style>
</head><body>${container.innerHTML}</body></html>`;
    return { srcDoc: doc, hasRemote: remote };
  }, [html, attachments, attachmentUrl, allowRemote]);

  return (
    <div className="flex h-full flex-col">
      {hasRemote && !allowRemote && (
        <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-amber-200 bg-amber-50 px-4 py-2 text-xs text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/40 dark:text-amber-200">
          <span>Remote images and styles are blocked to protect your privacy.</span>
          <button
            type="button"
            onClick={() => setAllowRemote(true)}
            className="shrink-0 rounded-md px-2 py-1 font-medium underline-offset-2 hover:underline"
          >
            Load remote content
          </button>
        </div>
      )}
      <iframe
        title="Email content"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerPolicy="no-referrer"
        srcDoc={srcDoc}
        className="min-h-[60vh] w-full flex-1 bg-white"
      />
    </div>
  );
}
