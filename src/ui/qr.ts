import QRCode from "qrcode";

/** Render a QR code for `text` into a fresh canvas. */
export async function renderQr(text: string, size = 320): Promise<HTMLCanvasElement> {
  const canvas = document.createElement("canvas");
  await QRCode.toCanvas(canvas, text, {
    width: size,
    margin: 1,
    errorCorrectionLevel: "M",
    color: { dark: "#0b0e14", light: "#ffffff" },
  });
  return canvas;
}
