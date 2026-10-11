// Rewrites the SPA's index.html so canonical and Open Graph URLs point at the host that
// serves it (or SITE_URL), instead of a hard-coded domain.

import { siteOrigin } from "./config";

/** Attributes holding a root-relative URL that must be absolute for crawlers. */
const ABSOLUTE_URL_TAGS: Array<[selector: string, attr: string]> = [
  ['link[rel="canonical"]', "href"],
  ['meta[property="og:url"]', "content"],
  ['meta[property="og:image"]', "content"],
  ['meta[name="twitter:image"]', "content"],
];

export function withSiteUrls(res: Response, env: Env, requestUrl: string): Response {
  if (!res.headers.get("content-type")?.includes("text/html")) return res;
  const origin = siteOrigin(env, new URL(requestUrl).origin);
  let rewriter = new HTMLRewriter();
  for (const [selector, attr] of ABSOLUTE_URL_TAGS) {
    rewriter = rewriter.on(selector, {
      element(el) {
        const value = el.getAttribute(attr);
        if (value?.startsWith("/")) el.setAttribute(attr, origin + value);
      },
    });
  }
  return rewriter.transform(res);
}
