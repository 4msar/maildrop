import { useEffect, useState } from "react";

// Two routes only ("/" and "/inbox/:username"), so a tiny History API router is enough.

export type Route = { name: "home" } | { name: "inbox"; username: string };

function parse(pathname: string): Route {
  const m = /^\/inbox\/([^/]+)\/?$/.exec(pathname);
  if (m) {
    try {
      return { name: "inbox", username: decodeURIComponent(m[1]).toLowerCase() };
    } catch {
      return { name: "home" };
    }
  }
  return { name: "home" };
}

export function navigate(path: string): void {
  if (path === window.location.pathname) return;
  window.history.pushState(null, "", path);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function useRoute(): Route {
  const [route, setRoute] = useState(() => parse(window.location.pathname));
  useEffect(() => {
    const onPop = () => setRoute(parse(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return route;
}
