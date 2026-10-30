// Draws the detected skeleton over the phone camera preview (2D canvas, raw
// image coordinates). The canvas and video share the same CSS transform for
// the mirrored preview, so we never mirror the data here.

import type { Landmark } from "../protocol/messages";
import { DRAWN_JOINTS, OVERLAY_CONNECTIONS, SIDE_COLORS } from "../pose/landmarks";

const CSS_COLOR: Record<number, string> = {
  [SIDE_COLORS.left]: "#4f9dff",
  [SIDE_COLORS.right]: "#ff8a5c",
  [SIDE_COLORS.center]: "#c9d1e0",
};

export function drawOverlay(
  canvas: HTMLCanvasElement,
  landmarks: Landmark[] | null,
  videoW: number,
  videoH: number,
): void {
  if (canvas.width !== videoW || canvas.height !== videoH) {
    canvas.width = videoW;
    canvas.height = videoH;
  }
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  if (!landmarks) return;

  const vis = (lm?: Landmark) => (lm && lm.visibility !== undefined ? lm.visibility : 1);

  ctx.lineWidth = Math.max(2, videoW * 0.004);
  for (const [a, b] of OVERLAY_CONNECTIONS) {
    const la = landmarks[a];
    const lb = landmarks[b];
    if (!la || !lb) continue;
    const confident = vis(la) > 0.4 && vis(lb) > 0.4;
    ctx.strokeStyle = confident ? "rgba(201,209,224,0.9)" : "rgba(201,209,224,0.25)";
    ctx.beginPath();
    ctx.moveTo(la.x * videoW, la.y * videoH);
    ctx.lineTo(lb.x * videoW, lb.y * videoH);
    ctx.stroke();
  }

  const r = Math.max(3, videoW * 0.007);
  for (const { idx, side } of DRAWN_JOINTS) {
    const lm = landmarks[idx];
    if (!lm) continue;
    const confident = vis(lm) > 0.4;
    ctx.fillStyle = CSS_COLOR[SIDE_COLORS[side]] ?? "#fff";
    ctx.globalAlpha = confident ? 1 : 0.3;
    ctx.beginPath();
    ctx.arc(lm.x * videoW, lm.y * videoH, r, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}
