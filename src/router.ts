// Minimal hash-based router. Hash routing keeps deep links (QR URLs, pasted
// links) working on GitHub Pages without any server-side SPA fallback: the
// part before "#" is always the served index.html.

export interface Route {
  path: string; // e.g. "/camera"
  params: URLSearchParams;
}

export function parseHash(): Route {
  const raw = location.hash.replace(/^#/, "") || "/";
  const [path, query = ""] = raw.split("?");
  return {
    path: path.startsWith("/") ? path : `/${path}`,
    params: new URLSearchParams(query),
  };
}

export function navigate(path: string, params?: URLSearchParams): void {
  const q = params && params.toString() ? `?${params.toString()}` : "";
  location.hash = `#${path}${q}`;
}

export function onRouteChange(cb: (route: Route) => void): () => void {
  const handler = () => cb(parseHash());
  window.addEventListener("hashchange", handler);
  return () => window.removeEventListener("hashchange", handler);
}

/** Build an absolute, shareable URL for a route (used in the QR). */
export function absoluteUrl(path: string, params: URLSearchParams): string {
  const base = location.origin + location.pathname;
  const q = params.toString() ? `?${params.toString()}` : "";
  return `${base}#${path}${q}`;
}
