import { el, clear, statusPill, type StatusKind } from "../ui/dom";
import { renderQr } from "../ui/qr";
import { absoluteUrl } from "../router";
import { resolveConfig } from "../config";
import type { Route } from "../router";
import { createCameraPeer, type CameraPeer, type Link } from "../net/peer";
import { PoseEstimator, type PoseFrame } from "./poseEstimator";
import { drawOverlay } from "./overlay";
import { WakeLock } from "./wakeLock";
import { LM } from "../pose/landmarks";
import {
  helloAck,
  pong,
  type Landmark,
  type PoseMessage,
  type ProtocolMessage,
} from "../protocol/messages";
import { PROTOCOL_VERSION } from "../config";

type Phase = "idle" | "preview" | "waiting" | "connected" | "transmitting" | "lost";

interface CamState {
  phase: Phase;
  facing: "user" | "environment";
  mirrored: boolean;
  seq: number;
  latest: PoseFrame | null;
  token: string;
  accepted: boolean;
  infCount: number;
  sendCount: number;
  lastMetricT: number;
  infFps: number;
  sendHzActual: number;
  avgVisibility: number;
  inFrame: boolean;
  /** Telemetry reported back by the viewer (Quest) over the DataChannel. */
  viewerHeightM: number | null;
  viewerRttMs: number | null;
}

export function mountCamera(container: HTMLElement, route: Route): () => void {
  const cfg = resolveConfig(route.params);
  const state: CamState = {
    phase: "idle",
    facing: "user",
    mirrored: true,
    seq: 0,
    latest: null,
    token: "", // set to the short pairing code once the peer opens
    accepted: false,
    infCount: 0,
    sendCount: 0,
    lastMetricT: performance.now(),
    infFps: 0,
    sendHzActual: 0,
    avgVisibility: 0,
    inFrame: false,
    viewerHeightM: null,
    viewerRttMs: null,
  };

  const video = el("video", { playsinline: true, muted: true }) as HTMLVideoElement;
  video.muted = true;
  const overlay = el("canvas") as HTMLCanvasElement;
  const videoWrap = el("div", { class: "video-wrap mirror" }, [video, overlay]);

  const statusHost = el("div", { class: "row" });
  const metricsHost = el("div", { class: "metrics" });
  const warnHost = el("div", {});
  const pairingHost = el("div", { class: "card hidden" });
  const controls = el("div", { class: "row" });

  const page = el("div", { class: "page" }, [
    el("h1", { text: "Modo cámara" }),
    el("div", { class: "card" }, [
      el("h3", { text: "1 · Colocación" }),
      el("p", {
        text: "Apoyá el teléfono de frente a vos, estable y vertical, de modo que se vea tu cuerpo completo (cabeza a pies). Alejate 2–3 m.",
      }),
    ]),
    videoWrap,
    statusHost,
    warnHost,
    controls,
    el("div", { class: "card" }, [el("h3", { text: "Métricas" }), metricsHost]),
    pairingHost,
    el("button", { class: "ghost", onclick: () => (location.hash = "#/") }, ["← Volver"]),
  ]);
  container.append(page);

  // --- lifecycle resources ---
  const estimator = new PoseEstimator();
  const wakeLock = new WakeLock();
  let stream: MediaStream | null = null;
  let cameraPeer: CameraPeer | null = null;
  let link: Link | null = null;
  let rvfcHandle = 0;
  let rafHandle = 0;
  let sendTimer = 0;
  let metricTimer = 0;
  let lastInfTime = 0;
  let disposed = false;

  function setStatus(label: string, kind: StatusKind): void {
    clear(statusHost);
    statusHost.append(statusPill(label, kind));
  }

  function phaseLabel(): [string, StatusKind] {
    switch (state.phase) {
      case "idle":
        return ["Sin iniciar", "wait"];
      case "preview":
        return ["Vista previa activa", "wait"];
      case "waiting":
        return ["Esperando visor…", "wait"];
      case "connected":
        return ["Visor conectado · calibrando", "ok"];
      case "transmitting":
        return ["Transmitiendo pose", "ok"];
      case "lost":
        return ["Conexión perdida", "err"];
    }
  }

  function refreshStatus(): void {
    const [l, k] = phaseLabel();
    setStatus(l, k);
  }

  // --- camera ---
  async function startCamera(): Promise<void> {
    try {
      stream?.getTracks().forEach((t) => t.stop());
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: state.facing, width: { ideal: 640 }, height: { ideal: 480 } },
        audio: false,
      });
      video.srcObject = stream;
      await video.play();
      videoWrap.classList.toggle("mirror", state.mirrored);
      state.phase = "preview";
      refreshStatus();
      renderControls();
      if (!estimator.ready) await estimator.init();
      startInferenceLoop();
      startPairing();
      void wakeLock.request();
    } catch (e) {
      warnHost.replaceChildren(
        el("p", {
          class: "err-text",
          text: `No se pudo acceder a la cámara: ${(e as Error).message}`,
        }),
      );
    }
  }

  function renderControls(): void {
    clear(controls);
    if (state.phase === "idle") {
      controls.append(
        el("button", { onclick: () => void startCamera() }, ["2 · Permitir cámara y empezar"]),
      );
      return;
    }
    controls.append(
      el(
        "button",
        {
          class: "secondary",
          onclick: () => {
            state.facing = state.facing === "user" ? "environment" : "user";
            void startCamera();
          },
        },
        [state.facing === "user" ? "Cambiar a cámara trasera" : "Cambiar a cámara frontal"],
      ),
      el(
        "button",
        {
          class: "secondary",
          onclick: () => {
            state.mirrored = !state.mirrored;
            videoWrap.classList.toggle("mirror", state.mirrored);
            renderControls();
          },
        },
        [state.mirrored ? "Vista espejada: SÍ" : "Vista espejada: NO"],
      ),
    );
  }

  // --- inference loop (throttled to inferenceHz) ---
  function startInferenceLoop(): void {
    const minDt = 1000 / cfg.inferenceHz;
    const anyVideo = video as unknown as {
      requestVideoFrameCallback?: (cb: () => void) => number;
    };

    const run = () => {
      if (disposed) return;
      const now = performance.now();
      if (now - lastInfTime >= minDt && video.videoWidth > 0) {
        lastInfTime = now;
        const frame = estimator.detect(video, now);
        if (frame) {
          state.latest = frame;
          state.infCount++;
          updateFrameQuality(frame.landmarks);
          drawOverlay(overlay, frame.landmarks, video.videoWidth, video.videoHeight);
        } else {
          drawOverlay(overlay, null, video.videoWidth || 1, video.videoHeight || 1);
          state.inFrame = false;
        }
      }
      schedule();
    };
    const schedule = () => {
      if (typeof anyVideo.requestVideoFrameCallback === "function") {
        rvfcHandle = anyVideo.requestVideoFrameCallback!(run);
      } else {
        rafHandle = requestAnimationFrame(run);
      }
    };
    schedule();
  }

  function updateFrameQuality(landmarks: Landmark[]): void {
    const key = [
      LM.LEFT_SHOULDER,
      LM.RIGHT_SHOULDER,
      LM.LEFT_HIP,
      LM.RIGHT_HIP,
      LM.LEFT_ANKLE,
      LM.RIGHT_ANKLE,
    ];
    let sum = 0;
    let inFrame = true;
    for (const i of key) {
      const lm = landmarks[i];
      const v = lm?.visibility ?? 1;
      sum += v;
      if (!lm || v < 0.5 || lm.x < 0.02 || lm.x > 0.98 || lm.y < 0.02 || lm.y > 0.98) {
        inFrame = false;
      }
    }
    state.avgVisibility = sum / key.length;
    state.inFrame = inFrame;
  }

  // --- pairing / signalling ---
  async function startPairing(): Promise<void> {
    if (cameraPeer) return;
    pairingHost.classList.remove("hidden");
    clear(pairingHost);
    pairingHost.append(el("h3", { text: "3 · Emparejar con el visor" }), el("p", { text: "Creando sesión…" }));
    try {
      cameraPeer = await createCameraPeer(cfg);
    } catch (e) {
      clear(pairingHost);
      pairingHost.append(
        el("h3", { text: "3 · Emparejar con el visor" }),
        el("p", { class: "err-text", text: `No se pudo crear la sesión: ${(e as Error).message}` }),
        el("button", { onclick: () => void startPairing() }, ["Reintentar"]),
      );
      return;
    }
    // The short pairing code IS the peer id; it also serves as the session
    // token for the handshake (see README: short-code path).
    state.token = cameraPeer.id;
    state.phase = "waiting";
    refreshStatus();

    const code = cameraPeer.id;
    const params = new URLSearchParams({ peer: code, token: code });
    const url = absoluteUrl("/quest", params);
    const qr = await renderQr(url);

    const sessionDot = el("span", { class: "status" }, [el("span", { class: "dot wait" }), "Sesión"]);
    cameraPeer.onStatus((s) => updateSessionDot(sessionDot, s));

    clear(pairingHost);
    pairingHost.append(
      el("div", { class: "row" }, [el("h3", { class: "grow", text: "3 · Emparejar con el visor" }), sessionDot]),
      el("p", {
        html: "En el visor, elegí <b>Código de emparejamiento</b> y escribí este código:",
      }),
      el("div", { class: "code-big mono" }, [code]),
      row(copyBtn(code)),
      el("details", {}, [
        el("summary", { text: "Otras formas (QR / enlace)" }),
        el("p", {
          class: "muted",
          text: "El escaneo de QR puede no funcionar en algunos visores. Si falla, usá el código de arriba.",
        }),
        el("div", { class: "qr" }, [qr]),
        el("label", {}, [
          "Enlace de emparejamiento",
          row(el("input", { type: "text", class: "grow mono", value: url, readonly: true }), copyBtn(url)),
        ]),
      ]),
    );

    cameraPeer.onViewer((l) => bindViewer(l));
    cameraPeer.onError((err) => {
      warnHost.replaceChildren(el("p", { class: "warning", text: `Señalización: ${err.message}` }));
    });
  }

  function updateSessionDot(pill: HTMLElement, s: string): void {
    const map: Record<string, [string, string]> = {
      open: ["ok", "Sesión activa"],
      reconnecting: ["warn", "Reconectando…"],
      disconnected: ["err", "Sesión caída"],
      closed: ["err", "Sesión cerrada"],
      error: ["err", "Error de sesión"],
    };
    const [kind, label] = map[s] ?? ["wait", "Sesión"];
    pill.replaceChildren(el("span", { class: `dot ${kind}` }), label);
  }

  function bindViewer(l: Link): void {
    link = l;
    l.onState((s) => {
      if (s === "closed" || s === "error") {
        state.phase = "lost";
        state.accepted = false;
        refreshStatus();
      }
    });
    l.onMessage((m: ProtocolMessage) => handleViewerMessage(l, m));
    state.phase = "connected";
    refreshStatus();
  }

  function handleViewerMessage(l: Link, m: ProtocolMessage): void {
    switch (m.t) {
      case "hello":
        if (m.token === state.token) {
          state.accepted = true;
          l.send(helloAck(true));
          state.phase = "transmitting";
          refreshStatus();
        } else {
          l.send(helloAck(false, "token inválido"));
          setTimeout(() => l.close(), 200);
        }
        break;
      case "ping":
        l.send(pong(m.tSent));
        break;
      case "status":
        // Viewer telemetry (estimated height / RTT it measured). Display only.
        if (m.heightM !== undefined) state.viewerHeightM = m.heightM;
        if (m.rttMs !== undefined) state.viewerRttMs = m.rttMs;
        renderMetrics();
        break;
      case "reset":
        state.seq = 0;
        break;
      default:
        break;
    }
  }

  // --- pose sender (throttled to sendHz, with backpressure) ---
  function startSender(): void {
    sendTimer = window.setInterval(() => {
      if (!link || !state.accepted || !state.latest) return;
      const frame = state.latest;
      const msg: PoseMessage = {
        v: PROTOCOL_VERSION,
        t: "pose",
        seq: state.seq++,
        // Convert the performance-clock inference time to epoch ms (see protocol).
        tCapture: performance.timeOrigin + frame.timestampMs,
        video: {
          width: video.videoWidth || 0,
          height: video.videoHeight || 0,
          facing: state.facing,
          previewMirrored: state.mirrored,
        },
        landmarks: frame.landmarks,
        worldLandmarks: frame.worldLandmarks.length ? frame.worldLandmarks : undefined,
      };
      const ok = link.send(msg, { dropIfBusy: true, maxBufferedBytes: cfg.maxBufferedBytes });
      if (ok) state.sendCount++;
    }, 1000 / cfg.sendHz);
  }

  // --- metrics ---
  function startMetrics(): void {
    renderMetrics();
    metricTimer = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - state.lastMetricT) / 1000;
      if (dt > 0) {
        state.infFps = state.infCount / dt;
        state.sendHzActual = state.sendCount / dt;
      }
      state.infCount = 0;
      state.sendCount = 0;
      state.lastMetricT = now;
      renderMetrics();
    }, 1000);
  }

  function renderMetrics(): void {
    clear(metricsHost);
    const dropped = link?.droppedForBackpressure ?? 0;
    const conn = link ? link.state : "sin visor";
    const metric = (label: string, value: string) =>
      el("div", { class: "metric" }, [el("b", { text: value }), label]);
    metricsHost.append(
      metric("FPS inferencia", state.infFps.toFixed(1)),
      metric("Hz envío", state.sendHzActual.toFixed(1)),
      metric("Conexión", String(conn)),
      metric("Visibilidad media", state.avgVisibility.toFixed(2)),
      metric("Paquetes descartados", String(dropped)),
      metric("Encuadre", state.inFrame ? "OK" : "fuera"),
      metric("Altura estimada (visor)", state.viewerHeightM == null ? "—" : `${state.viewerHeightM.toFixed(2)} m`),
      metric("RTT (visor)", state.viewerRttMs == null ? "—" : `${state.viewerRttMs.toFixed(0)} ms`),
    );
    warnHost.replaceChildren(
      state.phase !== "idle" && !state.inFrame
        ? el("p", { class: "warning", text: "⚠️ El cuerpo está fuera de encuadre o con baja visibilidad." })
        : document.createComment(""),
    );
  }

  // helpers
  function row(...nodes: Node[]): HTMLElement {
    return el("div", { class: "row" }, nodes);
  }
  function copyBtn(text: string): HTMLElement {
    return el(
      "button",
      {
        class: "secondary",
        onclick: (ev: Event) => {
          void navigator.clipboard?.writeText(text);
          (ev.target as HTMLElement).textContent = "Copiado";
        },
      },
      ["Copiar"],
    );
  }

  // boot
  refreshStatus();
  renderControls();
  startSender();
  startMetrics();

  // cleanup
  return () => {
    disposed = true;
    if (sendTimer) clearInterval(sendTimer);
    if (metricTimer) clearInterval(metricTimer);
    if (rafHandle) cancelAnimationFrame(rafHandle);
    const anyVideo = video as unknown as { cancelVideoFrameCallback?: (h: number) => void };
    if (rvfcHandle && anyVideo.cancelVideoFrameCallback) anyVideo.cancelVideoFrameCallback(rvfcHandle);
    estimator.close();
    stream?.getTracks().forEach((t) => t.stop());
    link?.close();
    cameraPeer?.destroy();
    void wakeLock.release();
    page.remove();
  };
}
