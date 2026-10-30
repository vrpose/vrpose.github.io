// Pure pairing-code/link parsing (no DOM / network imports) so it is safe to
// unit-test in Node.

export interface Pairing {
  peer: string;
  token: string;
}

/** Extract peer/token from a pairing URL or a "peer#token" shorthand. */
export function parsePairingUrl(raw: string): Pairing | null {
  const text = raw.trim();
  if (!text) return null;
  const hashForm = text.match(/^([\w-]+)#([\w-]+)$/);
  if (hashForm) return { peer: hashForm[1], token: hashForm[2] };
  try {
    const url = new URL(text);
    const hash = url.hash.replace(/^#/, "");
    const q = hash.includes("?") ? hash.split("?")[1] : url.search.replace(/^\?/, "");
    const params = new URLSearchParams(q);
    const peer = params.get("peer");
    const token = params.get("token");
    if (peer && token) return { peer, token };
  } catch {
    /* not a URL */
  }
  return null;
}
