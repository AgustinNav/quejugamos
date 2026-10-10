// Free hosts (Render) sleep after ~15 min without *inbound* requests, and SSE only flows
// server -> client. A visible room tab pings so the server doesn't sleep mid-vote (and lose
// the in-memory room). Hidden/forgotten tabs stay quiet so they don't burn free hours.
const PING_INTERVAL_MS = 4 * 60 * 1000;

export function startKeepAlive(code) {
  const timer = setInterval(() => {
    if (document.visibilityState !== 'visible') return;
    fetch(`/api/rooms/${encodeURIComponent(code)}`, { cache: 'no-store' })
      .catch((err) => console.warn('[keepalive] ping failed:', err));
  }, PING_INTERVAL_MS);
  return () => clearInterval(timer);
}
