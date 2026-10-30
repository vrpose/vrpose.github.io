// Bounded "latest pose" buffer.
//
// For a mirror we only ever care about the most recent pose; old poses are
// worthless. Rather than a growing queue we keep a single slot and apply two
// freshness rules on offer():
//   1. Reject packets whose seq is <= the newest accepted seq (out of order /
//      duplicate — relevant because we use an unordered DataChannel).
//   2. Reject packets whose capture time is older than the newest accepted one
//      (defence in depth against seq wrap / reset).
// Additionally the caller can reject packets whose LOCAL age (time since the
// buffer received them) exceeds a threshold before consuming.

import type { PoseMessage } from "./messages";

export interface BufferedPose {
  pose: PoseMessage;
  /** Local receive time on THIS device (epoch ms). Used for freshness. */
  receivedAt: number;
}

export class LatestPoseBuffer {
  private current: BufferedPose | null = null;
  private lastSeq = -Infinity;
  private lastCapture = -Infinity;
  private accepted = 0;
  private rejected = 0;

  /** Offer a freshly-received pose. Returns true if it replaced the slot. */
  offer(pose: PoseMessage, receivedAt: number): boolean {
    if (pose.seq <= this.lastSeq || pose.tCapture < this.lastCapture) {
      this.rejected++;
      return false;
    }
    this.current = { pose, receivedAt };
    this.lastSeq = pose.seq;
    this.lastCapture = pose.tCapture;
    this.accepted++;
    return true;
  }

  /** The most recent pose, or null. Does not clear the slot. */
  peek(): BufferedPose | null {
    return this.current;
  }

  /** Local age in ms of the current pose relative to `now`. Infinity if empty. */
  ageMs(now: number): number {
    return this.current ? now - this.current.receivedAt : Infinity;
  }

  /** Clear on disconnect/reset so stale data can't linger as "live". */
  clear(): void {
    this.current = null;
    // Do not reset lastSeq here: if a reset message resets the sender's seq,
    // call resetSequence() explicitly.
  }

  /** Allow the sender's sequence to restart (after a RESET handshake). */
  resetSequence(): void {
    this.lastSeq = -Infinity;
    this.lastCapture = -Infinity;
  }

  get stats(): { accepted: number; rejected: number } {
    return { accepted: this.accepted, rejected: this.rejected };
  }
}
