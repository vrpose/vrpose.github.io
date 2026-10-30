import { Quaternion, Vector3 } from "three";
import { el, clear, statusPill, type StatusKind } from "../ui/dom";
import type { Route } from "../router";
import { resolveConfig } from "../config";
import { connectToCamera, type Link } from "../net/peer";
import { QrScanner } from "./qrScanner";
import { XrScene } from "./xrScene";
import { SkeletonRenderer } from "./skeleton";
import { PoseMapper, defaultCalibration, type Calibration } from "./poseMapper";
import { LatestPoseBuffer } from "../protocol/queue";
import { RttMeter } from "../protocol/clock";
import { measureModelHeight, similarityFrom3Points, worldLandmarkToLocal, yawFacing } from "../math/transforms";
import { LM, POSE_LANDMARK_COUNT } from "../pose/landmarks";
import { parsePairingUrl } from "./pairing";
import { hello, ping, reset, status, nowEpochMs, type ProtocolMessage } from "../protocol/messages";

export function mountQuest(container: HTMLElement, route: Route): () => void {
  const cfg = resolveConfig(route.params);
  const page = el("div", { class: "page" });
  container.append(page);

  let link: Link | null = null;
  let peerHandle: { destroy: () => void } | null = null;
  let scene: XrScene | null = null;
  let skeleton: SkeletonRenderer | null = null;
  const mapper = new PoseMapper();
  const buffer = new LatestPoseBuffer();
  const rtt = new RttMeter();
  let cal: Calibration = defaultCalibration();
  // Default: self-overlay, not mirrored (see user request).
  cal.mirror = false;
  let pingTimer = 0;
  let disposed = false;

  // Only one placement remains: "Sobre mí" (first-person overlay). The old
  // mirror placement was removed — orientation now comes from the hand tracker
  // (see calibrateScale), which makes a separate mirror mode unnecessary and
  // removed a source of back-to-front errors.
  const placement = {
    height: 0,
    scale: 1,
    yaw: 0, // manual fine-tune on top of the auto yaw
    forward: 0, // shift along the body's facing direction
  };
  let controlPanel: HTMLElement | null = null;
  let arOverlayRoot: HTMLElement | null = null;

  // Overlay auto-calibration, solved ONCE from 3 point correspondences
  // (head↔headset and both wrists↔tracked hands). We keep the rotation-invariant
  // SCALE and the YAW: the yaw is the horizontal component of the solved rotation
  // (gravity-locked, so the figure can't tip), which is what makes the figure
  // FACE correctly and the wrists coincide with the tracked hands — the headset
  // gaze is NOT used for orientation. Held after solving to avoid jitter.
  const auto = { scale: 1, yaw: new Quaternion(), has: false };

  // Position anchor for the overlay figure. Low-pass filtered so quick head
  // motion is damped while slow body translation (walking) still tracks.
  const anchor = { pos: new Vector3(), posInit: false, lastT: 0 };
  function resetAnchor(): void {
    anchor.posInit = false;
  }

  function togglePanel(): void {
    if (!controlPanel) return;
    controlPanel.classList.toggle("hidden");
  }

  // --- pairing screen ---
  function renderPairing(prefillPeer = "", prefillToken = ""): void {
    clear(page);
    const codeInput = el("input", {
      type: "text",
      class: "grow mono code-input",
      placeholder: "ABC123",
      autocapitalize: "characters",
      autocomplete: "off",
      maxlength: 12,
      value: prefillPeer,
    }) as HTMLInputElement;
    const linkInput = el("input", { type: "text", class: "grow mono", placeholder: "pegá el enlace del QR" }) as HTMLInputElement;
    const scanHost = el("div", {});
    const msg = el("p", {});

    const tryConnect = (p: string, t: string) => {
      if (!p || !t) {
        msg.textContent = "Falta el código de emparejamiento.";
        msg.className = "err-text";
        return;
      }
      void connect(p.trim(), t.trim());
    };
    // The short code is both the peer id AND the token.
    const connectWithCode = () => {
      const code = codeInput.value.trim().toUpperCase();
      tryConnect(code, code);
    };
    codeInput.addEventListener("keydown", (e) => {
      if ((e as KeyboardEvent).key === "Enter") connectWithCode();
    });

    page.append(
      el("h1", { text: "Modo visor (Quest)" }),
      el("div", { class: "card" }, [
        el("h3", { text: "Código de emparejamiento" }),
        el("p", { text: "Escribí el código que muestra el celular (modo cámara)." }),
        codeInput,
        el("button", { onclick: connectWithCode }, ["Emparejar"]),
      ]),
      el("div", { class: "card" }, [
        el("h3", { text: "Pegar enlace" }),
        el("div", { class: "row" }, [
          linkInput,
          el("button", {
            class: "secondary",
            onclick: () => {
              const parsed = parsePairingUrl(linkInput.value);
              if (parsed) tryConnect(parsed.peer, parsed.token);
              else {
                msg.textContent = "No pude leer el emparejamiento del enlace.";
                msg.className = "err-text";
              }
            },
          }, ["Conectar"]),
        ]),
      ]),
      el("details", { class: "card" }, [
        el("summary", { text: "Escanear QR (puede no funcionar en el visor)" }),
        el("p", { text: "Solo si el navegador del visor expone una cámara utilizable y concede permiso. Si falla, usá el código de arriba." }),
        el("button", { class: "secondary", onclick: () => void startScan(scanHost, msg) }, ["Escanear con la cámara"]),
        scanHost,
      ]),
      msg,
      el("button", { class: "ghost", onclick: () => (location.hash = "#/") }, ["← Volver"]),
    );
    void prefillToken;
    codeInput.focus();
  }

  async function startScan(host: HTMLElement, msg: HTMLElement): Promise<void> {
    clear(host);
    if (!(await QrScanner.hasCamera())) {
      msg.textContent = "No se detectó cámara utilizable. Usá el enlace o el formulario.";
      msg.className = "warning";
      return;
    }
    const scanner = new QrScanner();
    const vid = scanner.videoElement;
    vid.className = "";
    const wrap = el("div", { class: "video-wrap" }, [vid]);
    host.append(wrap);
    try {
      const res = await scanner.start((e) => {
        msg.textContent = `Cámara: ${e.message}. Usá el enlace o el formulario.`;
        msg.className = "warning";
      });
      const parsed = parsePairingUrl(res.text);
      wrap.remove();
      if (parsed) void connect(parsed.peer, parsed.token);
      else {
        msg.textContent = "El QR no contiene un emparejamiento válido.";
        msg.className = "err-text";
      }
    } catch {
      wrap.remove();
      // Fallback already offered by the other cards; do not block.
    }
  }

  // --- connection + reception screen ---
  async function connect(peerId: string, token: string): Promise<void> {
    renderReception();
    const setState = (label: string, kind: StatusKind) => {
      const host = page.querySelector("#recv-status");
      if (host) host.replaceChildren(statusPill(label, kind));
    };
    setState("Conectando…", "wait");

    const conn = connectToCamera(peerId, cfg);
    peerHandle = conn;
    try {
      link = await conn.link;
    } catch (e) {
      setState(`No se pudo conectar: ${(e as Error).message}`, "err");
      page.append(el("button", { class: "secondary", onclick: () => renderPairing(peerId, token) }, ["Volver al emparejamiento"]));
      return;
    }

    link.onState((s) => {
      if (s === "closed" || s === "error") {
        setState("Conexión perdida", "err");
        skeleton?.setGlobalOpacity(0.15);
      }
    });
    link.onMessage((m: ProtocolMessage) => handleMessage(m, setState));

    // Authenticate with the session token.
    link.send(hello(token, "quest"));
    setState("Autenticando…", "wait");

    pingTimer = window.setInterval(() => link?.send(ping()), 1000);
  }

  function handleMessage(m: ProtocolMessage, setState: (l: string, k: StatusKind) => void): void {
    switch (m.t) {
      case "hello-ack":
        if (m.accepted) {
          setState("Emparejado · recibiendo pose", "ok");
          showEnterButton();
        } else {
          setState(`Rechazado: ${m.reason ?? "sin motivo"}`, "err");
        }
        break;
      case "pose":
        buffer.offer(m, nowEpochMs());
        break;
      case "pong":
        rtt.record(m.tSent, nowEpochMs());
        break;
      default:
        break;
    }
  }

  function renderReception(): void {
    clear(page);
    page.append(
      el("h1", { text: "Modo visor (Quest)" }),
      el("div", { class: "card" }, [el("h3", { text: "Estado" }), el("div", { id: "recv-status", class: "row" }, [statusPill("…", "wait")])]),
      el("div", { id: "enter-host" }),
      el("button", { class: "ghost", onclick: () => renderPairing() }, ["← Reemparejar"]),
    );
  }

  function showEnterButton(): void {
    const host = page.querySelector("#enter-host");
    if (!host || host.querySelector("button")) return;
    void XrScene.supportsAR().then((ok) => {
      host.append(
        el("p", {
          text: ok
            ? "Ponete el visor y entrá en realidad mixta para calibrar el espejo."
            : "WebXR immersive-ar no está disponible aquí. Podés abrir el modo de depuración 3D en escritorio.",
        }),
        el("button", { onclick: () => void enter(ok) }, [ok ? "Entrar en realidad mixta" : "Abrir depuración 3D"]),
      );
    });
  }

  // --- stage (XR / desktop) ---
  async function enter(ar: boolean): Promise<void> {
    clear(page);
    const stage = el("div", { class: "page" });
    stage.style.position = "relative";
    stage.style.minHeight = "70vh";
    const sceneHost = el("div", {});
    sceneHost.style.position = "absolute";
    sceneHost.style.inset = "0";
    const overlay = el("div", { class: ar ? "overlay-ui" : "row" });
    stage.append(sceneHost, overlay);
    page.append(stage);

    scene = new XrScene(ar ? document.body : sceneHost);
    skeleton = new SkeletonRenderer();
    scene.scene.add(skeleton.root);

    buildOverlayControls(overlay);

    scene.onFrame((tSec) => renderFrame(tSec));

    // WebXR input: a hand pinch (or a controller trigger) fires 'select'. We
    // route by handedness: LEFT pinch toggles the calibration panel; RIGHT
    // pinch / trigger recalibrates from the hands; BOTH together exit AR.
    // Handedness comes from the input source captured on 'connected'. These
    // events are not in three's typed Object3DEventMap, hence the casts.
    for (const c of scene.controllers) {
      const ev = c as unknown as {
        addEventListener: (t: string, cb: (e: { data?: { handedness?: string } }) => void) => void;
        userData: { handedness?: string };
      };
      ev.addEventListener("connected", (e) => {
        ev.userData.handedness = e.data?.handedness;
      });
      ev.addEventListener("disconnected", () => {
        ev.userData.handedness = undefined;
      });
      ev.addEventListener("select", () => {
        const hand = ev.userData.handedness;
        // Exit gesture: pinch BOTH hands within a short window (works even if
        // the dom-overlay panel isn't shown).
        const now = performance.now();
        if (hand === "left" || hand === "right") {
          selectTimes[hand] = now;
          const other = hand === "left" ? "right" : "left";
          if (now - selectTimes[other] < 450) {
            toast("Saliendo de realidad mixta…");
            void exitStage();
            return;
          }
        }
        if (hand === "left") {
          togglePanel();
          return;
        }
        // Right pinch / trigger: recalibrate scale + orientation from the hands.
        if (hand === "right") captureReference();
      });
    }

    if (ar) {
      // Make the overlay the dom-overlay root at the top level of the document
      // (nesting/stacking contexts can stop it from compositing in AR).
      arOverlayRoot = overlay;
      overlay.classList.add("ar-overlay");
      document.body.append(overlay);
      try {
        await scene.enterAR({ domOverlayRoot: overlay });
        const session = scene.renderer.xr.getSession() as unknown as { domOverlayState?: { type?: string } } | null;
        if (!session?.domOverlayState) {
          // DOM can't be shown over AR on this device: tell the user how to act
          // with gestures instead (this toast lives inside the overlay root).
          toast("Sin dom-overlay: pellizco izquierdo = panel, ambas manos = salir.");
        }
      } catch (e) {
        toast(`No se pudo entrar en AR: ${(e as Error).message}`);
      }
    }
  }

  const selectTimes: Record<"left" | "right", number> = { left: -1e9, right: -1e9 };

  function renderFrame(tSec: number): void {
    if (!scene || !skeleton) return;
    const buffered = buffer.peek();
    const age = buffer.ageMs(nowEpochMs());
    if (!buffered || age > cfg.maxPoseAgeMs) {
      // No fresh data: dim rather than freeze as if live.
      skeleton.setGlobalOpacity(0.15);
      return;
    }
    skeleton.setGlobalOpacity(1);
    const mapped = mapper.map(buffered.pose, cal, tSec);
    // Placement needs the mapped pose (to anchor to the body), so it runs after
    // mapping and before the skeleton update.
    placeOverlay(mapped.positions, tSec);
    skeleton.update(mapped.positions, mapped.confidence);
  }

  // Overlay placement (stable, never upside-down, no "neck brace"):
  //  - Vertical axis is locked to world up (gravity, from the headset), so the
  //    figure can never flip (no "feet on ceiling").
  //  - Yaw comes from the HAND TRACKER, not the gaze: calibrateScale solves the
  //    head+two-wrists correspondence and we keep its horizontal (yaw) component,
  //    so the figure faces the way your real body does and the wrists line up
  //    with the tracked hands. It is solved ONCE and HELD (turning/tilting your
  //    head no longer rotates the body).
  //  - Horizontal position is anchored to the stable HIP CENTRE (the body core),
  //    not the head, so head bobbing/looking around doesn't swing the feet. The
  //    head height is still matched to the headset so the core sits BELOW it.
  //  - The anchor position is low-pass filtered: quick head motion is damped,
  //    slow body translation (walking) still tracks over ~0.5 s.
  const UP = new Vector3(0, 1, 0);
  function placeOverlay(positions: (Vector3 | null)[], tSec: number): void {
    if (!scene || !skeleton) return;
    if (!auto.has) calibrateScale(); // one-shot until both hands are seen
    const s = auto.scale * placement.scale;
    const vp = scene.readViewerPose();

    // Orientation: the auto yaw from the hands, plus any manual fine-tune.
    const q = auto.yaw.clone();
    if (placement.yaw) q.multiply(new Quaternion().setFromAxisAngle(UP, placement.yaw));
    skeleton.root.quaternion.copy(q);
    skeleton.root.scale.setScalar(s);

    const localHead = positions[LM.NOSE];
    if (!localHead) return;
    // Stable horizontal reference: hip centre (falls back to head if missing).
    const lHip = positions[LM.LEFT_HIP];
    const rHip = positions[LM.RIGHT_HIP];
    const localCore = lHip && rHip ? lHip.clone().add(rHip).multiplyScalar(0.5) : localHead.clone();

    // Solve the root so the figure's CORE sits under the headset horizontally and
    // its HEAD sits at the headset height:
    //   world = pos + q·(s·local)  ⇒  pos = anchorWorld − q·(s·localRef)
    const wCore = localCore.clone().multiplyScalar(s).applyQuaternion(q);
    const wHead = localHead.clone().multiplyScalar(s).applyQuaternion(q);
    const target = new Vector3(
      vp.position.x - wCore.x,
      vp.position.y - wHead.y + placement.height,
      vp.position.z - wCore.z,
    );
    if (placement.forward) {
      const fwd = new Vector3(0, 0, 1).applyQuaternion(q);
      target.x += fwd.x * placement.forward;
      target.z += fwd.z * placement.forward;
    }

    if (!anchor.posInit) {
      anchor.pos.copy(target);
      anchor.posInit = true;
    } else {
      const dt = Math.max(0, Math.min(0.1, tSec - anchor.lastT));
      const tau = 0.5; // seconds; larger = steadier, laggier
      anchor.pos.lerp(target, 1 - Math.exp(-dt / tau));
    }
    anchor.lastT = tSec;
    skeleton.root.position.copy(anchor.pos);
  }

  /** Estimated real body height (m): model vertical span × the applied scale. */
  function estimatedHeightM(): number | null {
    if (!auto.has) return null;
    const wl = buffer.peek()?.pose.worldLandmarks;
    if (!wl) return null;
    const span = measureModelHeight(wl);
    if (!(span > 1e-3)) return null;
    return span * auto.scale * placement.scale;
  }

  // One-shot auto-calibration from the 3-point correspondence (head + both
  // wrists ↔ headset + both tracked hands). We keep:
  //   - SCALE: rotation-invariant, so stable even as the arms move;
  //   - YAW: the horizontal part of the solved rotation, which aligns the
  //     figure's facing (and its wrists) with the real tracked hands. Pitch/roll
  //     are dropped so the figure stays gravity-upright.
  // Called on demand (D / right pinch), not every frame.
  function calibrateScale(): boolean {
    if (!scene) return false;
    const buffered = buffer.peek();
    const wl = buffered?.pose.worldLandmarks;
    if (!wl || wl.length < POSE_LANDMARK_COUNT) return false;
    const lw = scene.wristWorld("left");
    const rw = scene.wristWorld("right");
    if (!lw || !rw) return false; // need both hands tracked
    const head = scene.readViewerPose().position;
    const localHead = worldLandmarkToLocal(wl[LM.NOSE], cal.mirror);
    const localL = worldLandmarkToLocal(wl[LM.LEFT_WRIST], cal.mirror);
    const localR = worldLandmarkToLocal(wl[LM.RIGHT_WRIST], cal.mirror);
    const t = similarityFrom3Points([localHead, localL, localR], [head, lw, rw]);
    if (!t) return false;
    auto.scale = Math.min(2.5, Math.max(0.3, t.scale));
    // Yaw = horizontal projection of the solved body-forward (+Z) axis.
    const fwd = new Vector3(0, 0, 1).applyQuaternion(t.quaternion);
    auto.yaw = yawFacing(fwd);
    auto.has = true;
    resetAnchor(); // re-center position on the next frame with the new yaw
    return true;
  }

  // --- overlay controls (work in AR via dom-overlay and on desktop) ---
  function buildOverlayControls(host: HTMLElement): void {
    const slider = (label: string, min: number, max: number, step: number, val: number, on: (v: number) => void) => {
      const input = el("input", { type: "range", min, max, step, value: val }) as HTMLInputElement;
      input.addEventListener("input", () => on(Number(input.value)));
      return el("label", {}, [label, input]);
    };

    const panel = el("div", { class: "card" }, [
      el("button", { onclick: () => void exitStage() }, ["⏹ Salir de realidad mixta"]),
      el("p", { class: "muted", text: "Sobre mí: mostrá ambas manos al visor y tocá D para calibrar escala y orientación." }),
      slider("Adelante/atrás (m)", -1, 1, 0.02, placement.forward, (v) => { placement.forward = v; }),
      slider("Altura (m)", -1, 1, 0.01, placement.height, (v) => { placement.height = v; }),
      slider("Escala", 0.5, 1.8, 0.01, placement.scale, (v) => { placement.scale = v; }),
      slider("Rotación fina (rad)", -Math.PI, Math.PI, 0.02, placement.yaw, (v) => { placement.yaw = v; }),
      el("div", { class: "row" }, [
        el("button", { class: "secondary", onclick: () => void captureReference() }, ["D · Calibrar (parado, ambas manos)"]),
        el("button", { class: "secondary", onclick: () => flipReflection() }, ["E · Corregir izq/der (levantá mano derecha)"]),
      ]),
      el("div", { id: "ql-metrics", class: "metrics" }),
      el("p", { class: "muted", text: "Pellizco izquierdo: panel · Pellizco derecho: recalibrar · Ambas manos: salir." }),
    ]);
    controlPanel = panel;
    host.append(panel);

    // live metrics in overlay
    const mTimer = window.setInterval(() => {
      const host2 = panel.querySelector("#ql-metrics");
      const age = buffer.ageMs(nowEpochMs());
      const r = rtt.rttMs;
      const h = estimatedHeightM();
      const stats = buffer.stats;
      if (host2) {
        host2.replaceChildren(
          metric("RTT", r == null ? "—" : `${r.toFixed(0)} ms`),
          metric("Altura estimada", h == null ? "—" : `${h.toFixed(2)} m`),
          metric("Antigüedad pose (local)", Number.isFinite(age) ? `${age.toFixed(0)} ms` : "—"),
          metric("Aceptadas", String(stats.accepted)),
          metric("Rechazadas (viejas)", String(stats.rejected)),
        );
      }
      // Report what the viewer computed back to the phone over the same channel.
      if (link?.state === "open") {
        link.send(status("metrics", undefined, { heightM: h ?? undefined, rttMs: r ?? undefined }));
      }
    }, 500);
    overlayTimers.push(mTimer);
  }

  const overlayTimers: number[] = [];

  // Full recalibrate: re-solve scale AND yaw from head + both hands.
  function captureReference(): void {
    auto.has = false;
    const ok = calibrateScale();
    toast(ok ? `Calibrado · escala ×${auto.scale.toFixed(2)}.` : "Mostrá ambas manos al visor para calibrar.");
  }

  // Flip the left/right correspondence (reflection). If the figure faces the
  // wrong way or mirrors your hands, toggling this and re-solving fixes it.
  function flipReflection(): void {
    cal.mirror = !cal.mirror;
    mapper.reset();
    skeleton?.resetRetained();
    auto.has = false; // re-solve yaw/scale under the new correspondence
    const ok = calibrateScale();
    toast(
      `Izq/der: ${cal.mirror ? "espejo" : "directo"}.` +
        (ok ? " Recalibrado." : " Mostrá ambas manos para recalibrar."),
    );
  }

  async function exitStage(): Promise<void> {
    for (const t of overlayTimers) clearInterval(t);
    overlayTimers.length = 0;
    scene?.dispose();
    skeleton?.dispose();
    scene = null;
    skeleton = null;
    controlPanel = null;
    // Remove the overlay we may have hoisted to <body> for dom-overlay.
    arOverlayRoot?.remove();
    arOverlayRoot = null;
    renderReception();
    const host = page.querySelector("#recv-status");
    if (host) host.replaceChildren(statusPill(link?.state === "open" ? "Emparejado" : "Desconectado", link?.state === "open" ? "ok" : "err"));
    showEnterButton();
  }

  // --- helpers ---
  function toast(text: string): void {
    const t = el("div", { class: "card", text });
    t.style.position = "fixed";
    t.style.top = "12px";
    t.style.left = "50%";
    t.style.transform = "translateX(-50%)";
    t.style.zIndex = "50";
    t.style.pointerEvents = "none";
    // In AR only the dom-overlay root subtree is composited, so toasts must live
    // inside it to be visible.
    (arOverlayRoot ?? document.body).append(t);
    setTimeout(() => t.remove(), 2600);
  }

  // boot
  const urlPeer = route.params.get("peer") ?? "";
  const urlToken = route.params.get("token") ?? "";
  if (urlPeer && urlToken) void connect(urlPeer, urlToken);
  else renderPairing(urlPeer, urlToken);

  return () => {
    disposed = true;
    void disposed;
    if (pingTimer) clearInterval(pingTimer);
    for (const t of overlayTimers) clearInterval(t);
    link?.send(reset());
    link?.close();
    peerHandle?.destroy();
    scene?.dispose();
    skeleton?.dispose();
    arOverlayRoot?.remove();
    page.remove();
  };
}

function metric(label: string, value: string): HTMLElement {
  return el("div", { class: "metric" }, [el("b", { text: value }), label]);
}
