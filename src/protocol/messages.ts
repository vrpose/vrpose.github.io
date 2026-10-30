// Typed, versioned wire protocol between the phone (camera) and the Quest
// (viewer). All messages carry `v` (protocol version) and `t` (type tag).
//
// TIME CONVENTION (documented, single source of truth):
// Every timestamp in this protocol is a Unix-epoch value in milliseconds,
// computed on the *sending* device as `performance.timeOrigin + performance.now()`.
// Because the two devices do NOT share a clock, a timestamp from the phone is
// NOT directly comparable to the Quest's clock. See protocol/clock.ts for how
// we reason about freshness (local age) and RTT instead of cross-device latency.

import { PROTOCOL_VERSION } from "../config";

export type MessageType =
  | "hello"
  | "hello-ack"
  | "pose"
  | "calibration"
  | "status"
  | "ping"
  | "pong"
  | "reset";

export interface BaseMessage {
  v: number;
  t: MessageType;
}

/** Viewer -> camera. Authenticates against the session token from the QR. */
export interface HelloMessage extends BaseMessage {
  t: "hello";
  token: string;
  /** Free-form viewer id for logs. */
  viewer: string;
}

/** Camera -> viewer. Accept/reject the viewer. */
export interface HelloAckMessage extends BaseMessage {
  t: "hello-ack";
  accepted: boolean;
  reason?: string;
}

/** A single landmark. visibility/presence are only present when MediaPipe
 * provides them; they are in [0,1]. */
export interface Landmark {
  x: number;
  y: number;
  z: number;
  visibility?: number;
  presence?: number;
}

/** Camera -> viewer. The core streaming payload. */
export interface PoseMessage extends BaseMessage {
  t: "pose";
  /** Monotonic sequence number from the sender. */
  seq: number;
  /** Capture/inference time (Unix epoch ms on the sender). See file header. */
  tCapture: number;
  /** Source video dimensions and orientation. */
  video: {
    width: number;
    height: number;
    facing: "user" | "environment" | "unknown";
    /** Whether the PHONE PREVIEW was shown mirrored. Purely informational:
     * transmitted landmark coordinates are always RAW (unmirrored) image
     * coordinates, so the viewer can apply its own mirror transform. */
    previewMirrored: boolean;
  };
  /** Normalised image-space landmarks (x,y in [0,1], origin top-left; z ~ depth
   * relative to hips in roughly the same unit as x). */
  landmarks: Landmark[];
  /** Metric, body-centred world landmarks (meters, origin ~ hip centre), when
   * available from MediaPipe. Not a room-global position. */
  worldLandmarks?: Landmark[];
}

/** Either direction. Carries calibration/handshake-adjacent info. */
export interface CalibrationMessage extends BaseMessage {
  t: "calibration";
  /** Real standing height in meters, entered by the user (optional aid). */
  userHeightM?: number;
  note?: string;
}

/** Either direction. Human-readable state updates, plus optional telemetry.
 * Used by the viewer (Quest) to report back to the camera (phone) what it
 * computed locally: the estimated real height (from the auto-calibrated scale)
 * and the RTT it measured. These are informational; the phone just displays
 * them. All numeric fields are optional and backward-compatible. */
export interface StatusMessage extends BaseMessage {
  t: "status";
  state: string;
  detail?: string;
  /** Estimated real body height in meters (model span × applied scale). */
  heightM?: number;
  /** Round-trip time (ms) measured on the sender's own clock. */
  rttMs?: number;
}

export interface PingMessage extends BaseMessage {
  t: "ping";
  /** Sender clock at send time (epoch ms). Echoed back in pong. */
  tSent: number;
}

export interface PongMessage extends BaseMessage {
  t: "pong";
  /** The `tSent` from the ping, echoed verbatim so the pinger can compute RTT
   * on its OWN clock. */
  tSent: number;
}

export interface ResetMessage extends BaseMessage {
  t: "reset";
}

export type ProtocolMessage =
  | HelloMessage
  | HelloAckMessage
  | PoseMessage
  | CalibrationMessage
  | StatusMessage
  | PingMessage
  | PongMessage
  | ResetMessage;

/** Current epoch-ms timestamp on this device (see time convention above). */
export function nowEpochMs(): number {
  return performance.timeOrigin + performance.now();
}

// --- Builders -------------------------------------------------------------

export function hello(token: string, viewer: string): HelloMessage {
  return { v: PROTOCOL_VERSION, t: "hello", token, viewer };
}

export function helloAck(accepted: boolean, reason?: string): HelloAckMessage {
  return { v: PROTOCOL_VERSION, t: "hello-ack", accepted, reason };
}

export function status(
  state: string,
  detail?: string,
  extra?: { heightM?: number; rttMs?: number },
): StatusMessage {
  const msg: StatusMessage = { v: PROTOCOL_VERSION, t: "status", state, detail };
  if (extra?.heightM !== undefined) msg.heightM = extra.heightM;
  if (extra?.rttMs !== undefined) msg.rttMs = extra.rttMs;
  return msg;
}

export function ping(): PingMessage {
  return { v: PROTOCOL_VERSION, t: "ping", tSent: nowEpochMs() };
}

export function pong(tSent: number): PongMessage {
  return { v: PROTOCOL_VERSION, t: "pong", tSent };
}

export function reset(): ResetMessage {
  return { v: PROTOCOL_VERSION, t: "reset" };
}
