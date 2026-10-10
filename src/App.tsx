import { useEffect, useState } from "react";
import { Header } from "./components/Header";
import { HomePage } from "./components/HomePage";
import { InboxPage } from "./components/InboxPage";
import { api } from "./lib/api";
import { useRoute } from "./lib/router";

const FALLBACK_DOMAIN = "maildrop.msar.me";

export default function App() {
  const route = useRoute();
  const [domain, setDomain] = useState(FALLBACK_DOMAIN);

  useEffect(() => {
    api
      .config()
      .then((c) => setDomain(c.domain))
      .catch(() => {
        // Keep the fallback; the inbox API reports the authoritative address anyway.
      });
  }, []);

  return (
    <div className="flex min-h-dvh flex-col">
      <Header />
      <div className="flex-1">
        {route.name === "inbox" ? <InboxPage username={route.username} domain={domain} /> : <HomePage domain={domain} />}
      </div>
      <footer className="py-6 text-center text-xs text-slate-500 dark:text-slate-400">
        Inboxes are public and temporary. Do not use them for passwords, banking or anything private.
      </footer>
    </div>
  );
}
