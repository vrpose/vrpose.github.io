// PeerJS wrapper.
//
// SIGNALLING: PeerJS needs a signalling server to broker the WebRTC handshake.
// With `new Peer()` and no host options it uses the PeerServer Cloud service
// (0.peerjs.com) — an EXTERNAL dependency. This is NOT a serverless design; it
// only avoids a *media/data* relay in the common case. See README.
//
// TRANSPORT: we request an UNRELIABLE, UNORDERED DataChannel (reliable:false).
// For live pose, a dropped packet is cheaper than head-of-line blocking behind
// a stale one. Because unordered delivery can reorder packets, the RECEIVER
// still guards freshness via sequence numbers + capture time (see
// protocol/queue.ts) — so correctness never depends on the transport ordering.

import Peer, { type DataConnection } from "peerjs";
import type { AppConfig } from "../config";
import type { ProtocolMessage } from "../protocol/messages";
import { parseMessage } from "../protocol/validate";

export type LinkState = "connecting" | "open" | "closed" | "error";

/** Lifecycle of the camera's registration with the signalling server. */
export type PeerStatus = "open" | "reconnecting" | "disconnected" | "closed" | "error";

// Short pairing code: easy to read/type on a headset. Excludes ambiguous
// characters (0/O, 1/I/L). ~30^6 ≈ 7e8 combinations — plenty for a prototype.
const SHORT_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

export function generateShortCode(len = 6): string {
  const buf = new Uint32Array(len);
  crypto.getRandomValues(buf);
  let s = "";
  for (let i = 0; i < len; i++) s += SHORT_ALPHABET[buf[i] % SHORT_ALPHABET.length];
  return s;
}

export interface SendOptions {
  /** Drop this message if the channel backlog exceeds maxBufferedBytes. */
  dropIfBusy?: boolean;
  maxBufferedBytes?: number;
}

/** Thin wrapper over a single DataConnection with validation + backpressure. */
export class Link {
  private messageCbs: ((m: ProtocolMessage) => void)[] = [];
  private stateCbs: ((s: LinkState) => void)[] = [];
  private _state: LinkState = "connecting";
  private _dropped = 0;

  constructor(private conn: DataConnection) {
    conn.on("open", () => this.setState("open"));
    conn.on("close", () => this.setState("closed"));
    conn.on("error", () => this.setState("error"));
    conn.on("data", (data: unknown) => {
      const msg = parseMessage(data);
      if (msg) for (const cb of this.messageCbs) cb(msg);
    });
    if (conn.open) this._state = "open";
  }

  get state(): LinkState {
    return this._state;
  }
  get peer(): string {
    return this.conn.peer;
  }
  get droppedForBackpressure(): number {
    return this._dropped;
  }
  get bufferedAmount(): number {
    const dc = this.conn.dataChannel;
    return dc ? dc.bufferedAmount : 0;
  }

  onMessage(cb: (m: ProtocolMessage) => void): void {
    this.messageCbs.push(cb);
  }
  onState(cb: (s: LinkState) => void): void {
    this.stateCbs.push(cb);
  }

  /** Returns true if sent, false if dropped (busy) or closed. */
  send(msg: ProtocolMessage, opts: SendOptions = {}): boolean {
    if (this._state !== "open" || !this.conn.open) return false;
    if (opts.dropIfBusy) {
      const limit = opts.maxBufferedBytes ?? 64 * 1024;
      if (this.bufferedAmount > limit) {
        this._dropped++;
        return false;
      }
    }
    try {
      this.conn.send(msg);
      return true;
    } catch {
      return false;
    }
  }

  close(): void {
    try {
      this.conn.close();
    } finally {
      this.setState("closed");
    }
  }

  private setState(s: LinkState): void {
    if (s === this._state) return;
    this._state = s;
    for (const cb of this.stateCbs) cb(s);
  }
}

export interface CameraPeer {
  peer: Peer;
  /** The short pairing code (also the PeerJS id). */
  id: string;
  /** Fires once when a viewer connects. We accept a single viewer. */
  onViewer(cb: (link: Link) => void): void;
  onError(cb: (err: Error) => void): void;
  /** Signalling-server registration status (for the "session alive" dot). */
  onStatus(cb: (s: PeerStatus) => void): void;
  destroy(): void;
}

interface PeerError {
  type?: string;
}

/** Open a PeerJS peer using a short custom id, retrying on id collisions. */
async function openPeerWithShortId(
  config: AppConfig,
  attempts = 6,
): Promise<{ peer: Peer; id: string }> {
  for (let i = 0; i < attempts; i++) {
    const id = generateShortCode(6);
    const peer = new Peer(id, { config: { iceServers: config.iceServers }, debug: 1 });
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error("Timeout abriendo la señalización")), 15000);
        const onOpen = () => {
          cleanup();
          resolve();
        };
        const onErr = (err: PeerError) => {
          cleanup();
          reject(err);
        };
        const cleanup = () => {
          clearTimeout(timeout);
          peer.off("open", onOpen);
          peer.off("error", onErr);
        };
        peer.on("open", onOpen);
        peer.on("error", onErr);
      });
      return { peer, id };
    } catch (err) {
      peer.destroy();
      if ((err as PeerError)?.type === "unavailable-id") continue; // retry a new code
      throw err instanceof Error ? err : new Error(String((err as PeerError)?.type ?? err));
    }
  }
  throw new Error("No se pudo reservar un código corto (demasiados intentos)");
}

/** Camera side: open a short-code peer, then listen for a single viewer. */
export async function createCameraPeer(config: AppConfig): Promise<CameraPeer> {
  const { peer, id } = await openPeerWithShortId(config);
  const viewerCbs: ((l: Link) => void)[] = [];
  const errorCbs: ((e: Error) => void)[] = [];
  const statusCbs: ((s: PeerStatus) => void)[] = [];
  let claimed = false;
  const status = (s: PeerStatus) => statusCbs.forEach((cb) => cb(s));

  peer.on("connection", (conn: DataConnection) => {
    if (claimed) {
      // Single viewer per session: refuse extra connections.
      conn.on("open", () => {
        try {
          conn.send({ v: 1, t: "hello-ack", accepted: false, reason: "busy" });
        } catch {
          /* ignore */
        }
        setTimeout(() => conn.close(), 250);
      });
      return;
    }
    claimed = true;
    const link = new Link(conn);
    link.onState((s) => {
      if (s === "closed" || s === "error") claimed = false; // allow re-pairing
    });
    for (const cb of viewerCbs) cb(link);
  });

  peer.on("error", (err) => {
    for (const cb of errorCbs) cb(err as unknown as Error);
  });

  // Keep the session (and its code) alive against the signalling server.
  peer.on("disconnected", () => {
    status("disconnected");
    try {
      peer.reconnect();
      status("reconnecting");
    } catch {
      /* reconnect not possible */
    }
  });
  peer.on("open", () => status("open")); // also fires after a successful reconnect
  peer.on("close", () => status("closed"));

  return {
    peer,
    id,
    onViewer: (cb) => viewerCbs.push(cb),
    onError: (cb) => errorCbs.push(cb),
    onStatus: (cb) => {
      statusCbs.push(cb);
      cb(peer.disconnected ? "disconnected" : "open");
    },
    destroy: () => peer.destroy(),
  };
}

/** Viewer side: connect to a camera peer id. Resolves when the channel opens. */
export function connectToCamera(
  cameraId: string,
  config: AppConfig,
): { peer: Peer; link: Promise<Link>; destroy: () => void } {
  const peer = new Peer({ config: { iceServers: config.iceServers }, debug: 1 });
  const link = new Promise<Link>((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error("Timeout conectando con la cámara")), 20000);
    peer.on("open", () => {
      const conn = peer.connect(cameraId, {
        reliable: false,
        serialization: "json",
        metadata: { role: "viewer" },
      });
      conn.on("open", () => {
        clearTimeout(timeout);
        resolve(new Link(conn));
      });
      conn.on("error", (err) => {
        clearTimeout(timeout);
        reject(err as unknown as Error);
      });
    });
    peer.on("error", (err) => {
      clearTimeout(timeout);
      reject(err as unknown as Error);
    });
  });
  return { peer, link, destroy: () => peer.destroy() };
}
