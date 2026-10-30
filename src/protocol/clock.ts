// Honest latency reasoning for two devices WITHOUT a shared clock.
//
// We expose two independent, well-defined quantities:
//   - RTT: measured by ping/pong on a single device's own clock. Reliable.
//   - localAge: time since WE received the latest pose, on our own clock.
//     This is NOT one-way network latency, but it is a useful freshness signal.
//
// We also provide an OPTIONAL, clearly-labelled estimate of the sender/receiver
// clock offset so a rough cross-device capture-age can be shown. It assumes a
// symmetric network path (the classic NTP/Cristian assumption) and carries an
// explicit uncertainty of ±RTT/2. Never present it as an exact measurement.

export class RttMeter {
  private samples: number[] = [];
  private readonly maxSamples = 16;

  /** Call when a pong returns, with the ping's original tSent (our clock). */
  record(tSent: number, nowOurClock: number): void {
    const rtt = nowOurClock - tSent;
    if (!Number.isFinite(rtt) || rtt < 0) return;
    this.samples.push(rtt);
    if (this.samples.length > this.maxSamples) this.samples.shift();
  }

  get rttMs(): number | null {
    if (this.samples.length === 0) return null;
    // Median is robust to the occasional spike.
    const s = [...this.samples].sort((a, b) => a - b);
    const mid = Math.floor(s.length / 2);
    return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
  }
}

/**
 * Rough clock-offset estimate via Cristian's algorithm.
 * offset ≈ remoteTimeAtResponse - (localSend + rtt/2)
 * @returns offset in ms (add to a remote timestamp to map it onto our clock)
 *          and the ±uncertainty. Returns null if inputs are invalid.
 */
export function estimateClockOffset(
  localSend: number,
  remoteTime: number,
  localRecv: number,
): { offsetMs: number; uncertaintyMs: number } | null {
  const rtt = localRecv - localSend;
  if (!Number.isFinite(rtt) || rtt < 0) return null;
  const offsetMs = remoteTime - (localSend + rtt / 2);
  return { offsetMs, uncertaintyMs: rtt / 2 };
}
