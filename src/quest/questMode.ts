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
import { buildMirrorFrame, measureModelHeight, similarityFrom3Points, worldLandmarkToLocal, yawFacing } from "../math/transforms";
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

  const placement = {
    mode: "overlay" as "mirror" | "overlay", // default: sobre mí
    fraction: 0.5,
    lateral: 0,
    height: 0,
    scale: 1,
    yaw: 0,
    forward: 0, // overlay: shift along the body's facing direction
  };
  let userPos: Vector3 | null = null;
  let phonePos: Vector3 | null = null;
  let markPhoneArmed = false;
  let controlPanel: HTMLElement | null = null;
  let arOverlayRoot: HTMLElement | null = null;

  // Overlay scale, calibrated once from 3 point correspondences (head↔headset
  // and both wrists↔tracked hands). Only the rotation-invariant SCALE is kept;
  // orientation is derived from the headset (gravity up + yaw) each frame.
  const auto = { scale: 1, has: false };

  // World anchor for the overlay figure, captured ONCE (at placement / D) and
  // then held. The body yaw is frozen so turning or tilting your head no longer
  // rotates the figure (this was the "neck brace" effect), and the position is
  // low-pass filtered so quick head motion is damped while slow body translation
  // (walking) still tracks. Recalibrate to re-aim/re-center.
  const anchor = { pos: new Vector3(), quat: new Quaternion(), has: false, posInit: false, lastT: 0 };
  function resetAnchor(): void {
    anchor.has = false;
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
    // pinch / trigger marks the phone when armed. Handedness comes from the
    // input source captured on 'connected'. These events are not in three's
    // typed Object3DEventMap, hence the casts.
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
        if (!markPhoneArmed || !scene) return;
        const hit = scene.controllerFloorHit(0) ?? scene.controllerFloorHit(1);
        if (hit) {
          phonePos = hit.clone();
          markPhoneArmed = false;
          recomputeFrame();
          toast("Celular marcado.");
        }
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
    // Overlay placement needs the mapped pose (to anchor to the body), so it
    // runs after mapping and before the skeleton update.
    if (placement.mode === "overlay") placeOverlay(mapped.positions, tSec);
    skeleton.update(mapped.positions, mapped.confidence);
  }

  // Overlay placement (stable, never upside-down, no "neck brace"):
  //  - Vertical axis is locked to world up (gravity, from the headset). We never
  //    apply a solved rotation, so the figure can't flip (no "feet on ceiling").
  //  - Yaw is captured ONCE (at placement / D) and HELD. Turning or tilting your
  //    head no longer rotates the body — that rigid coupling was the neck brace.
  //  - Horizontal position is anchored to the stable HIP CENTRE (the body core),
  //    not the head, so head bobbing/looking around doesn't swing the feet. The
  //    head height is still matched to the headset so the core sits BELOW it.
  //  - The anchor position is low-pass filtered: quick head motion is damped,
  //    slow body translation (walking) still tracks over ~0.5 s.
  //  - Scale is calibrated ONCE from head+hands (see calibrateScale), not per
  //    frame. Lying down etc. lives in the articulated pose, not in placement.
  const UP = new Vector3(0, 1, 0);
  function placeOverlay(positions: (Vector3 | null)[], tSec: number): void {
    if (!scene || !skeleton) return;
    if (!auto.has) calibrateScale(); // one-shot until it succeeds
    const s = auto.scale * placement.scale;
    const vp = scene.readViewerPose();

    // Capture (and freeze) the body yaw the first time we place it.
    if (!anchor.has) {
      anchor.quat = yawFacing(vp.forwardXZ);
      anchor.has = true;
      anchor.posInit = false;
      anchor.lastT = tSec;
    }
    const q = anchor.quat.clone();
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

  // One-shot scale from the 3-point correspondence (head + both wrists). Only
  // the SCALE is used (it is rotation-invariant and stable); the noisy solved
  // rotation/translation are discarded. Call on demand, not every frame.
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
    auto.has = true;
    return true;
  }

  function recomputeFrame(): void {
    if (!scene || !skeleton) return;
    if (placement.mode === "overlay") {
      return; // overlay is placed per-frame in placeOverlay()
    }
    if (!userPos || !phonePos) return;
    const frame = buildMirrorFrame({
      userPos,
      phonePos,
      fraction: placement.fraction,
      floorY: scene.floorY,
      lateralOffset: placement.lateral,
      extraYaw: placement.yaw,
    });
    skeleton.root.position.copy(frame.position);
    skeleton.root.position.y += placement.height;
    skeleton.root.quaternion.copy(frame.quaternion);
    skeleton.root.scale.setScalar(placement.scale);
  }

  // --- overlay controls (work in AR via dom-overlay and on desktop) ---
  function buildOverlayControls(host: HTMLElement): void {
    const slider = (label: string, min: number, max: number, step: number, val: number, on: (v: number) => void) => {
      const input = el("input", { type: "range", min, max, step, value: val }) as HTMLInputElement;
      input.addEventListener("input", () => on(Number(input.value)));
      return el("label", {}, [label, input]);
    };

    const modeBtn = el("button", {}, []);
    const abRow = el("div", { class: "row" }, [
      el("button", { onclick: () => {
          if (!scene) return;
          const vp = scene.readViewerPose();
          userPos = vp.position.clone();
          // Face the phone roughly where the user looks until the phone is marked.
          if (!phonePos) phonePos = vp.position.clone().add(vp.forwardXZ.clone().multiplyScalar(2));
          recomputeFrame();
          toast("Posición del usuario calibrada.");
        } }, ["A · Calibrar mi posición"]),
      el("button", { class: "secondary", onclick: () => { markPhoneArmed = true; toast("Apuntá al piso donde está el celular y apretá el gatillo."); } }, ["B · Marcar celular (gatillo)"]),
    ]);
    // Controls that only make sense for the mirror placement.
    const mirrorOnly = el("div", {}, [
      el("details", {}, [
        el("summary", { text: "Celular manual (distancia y dirección)" }),
        el("div", { class: "row" }, [
          el("label", {}, ["Distancia (m)", numInput(2, 0.3, 8, 0.1, (d) => setPhoneManual(d, undefined))]),
          el("label", {}, ["Dirección (°)", numInput(0, -90, 90, 5, (deg) => setPhoneManual(undefined, deg))]),
        ]),
      ]),
      slider("Distancia al espejo (fracción)", 0.1, 0.9, 0.01, placement.fraction, (v) => { placement.fraction = v; recomputeFrame(); }),
      slider("Lateral (m)", -1.5, 1.5, 0.02, placement.lateral, (v) => { placement.lateral = v; recomputeFrame(); }),
    ]);

    const applyModeLabel = () => {
      modeBtn.textContent = placement.mode === "mirror" ? "Modo: Espejo (enfrente)" : "Modo: Sobre mí (primera persona)";
      // A/B (phone position) and the mirror-only sliders are irrelevant in overlay.
      abRow.classList.toggle("hidden", placement.mode === "overlay");
      mirrorOnly.classList.toggle("hidden", placement.mode === "overlay");
    };
    const setMode = (m: "mirror" | "overlay") => {
      placement.mode = m;
      if (m === "overlay") {
        // Canonical body-space output; the root transform (auto-calibration)
        // carries scale/position/orientation.
        cal.scale = 1;
        cal.footBaselineLocal = 0;
        cal.lateralEnabled = false;
        cal.mirror = false;
        auto.has = false; // re-solve from the 3 points
        resetAnchor(); // re-aim yaw + re-center on next placement
      } else {
        cal.mirror = true; // mirror reflection; scale/floor come from D capture
      }
      mapper.reset();
      skeleton?.resetRetained();
      applyModeLabel();
      recomputeFrame();
      toast(
        m === "overlay"
          ? "Sobre mí: se calibra solo con cabeza + manos (mostrá ambas manos al visor)."
          : "Modo espejo.",
      );
    };
    modeBtn.addEventListener("click", () => setMode(placement.mode === "mirror" ? "overlay" : "mirror"));

    const panel = el("div", { class: "card" }, [
      el("button", { onclick: () => void exitStage() }, ["⏹ Salir de realidad mixta"]),
      modeBtn,
      abRow,
      mirrorOnly,
      slider("Adelante/atrás (m)", -1, 1, 0.02, placement.forward, (v) => { placement.forward = v; recomputeFrame(); }),
      slider("Altura (m)", -1, 1, 0.01, placement.height, (v) => { placement.height = v; recomputeFrame(); }),
      slider("Escala", 0.5, 1.8, 0.01, placement.scale, (v) => { placement.scale = v; recomputeFrame(); }),
      slider("Rotación (rad)", -Math.PI, Math.PI, 0.02, placement.yaw, (v) => { placement.yaw = v; recomputeFrame(); }),
      el("div", { class: "row" }, [
        el("button", { class: "secondary", onclick: () => void captureReference() }, ["D · Calibrar (parado, mirá al frente)"]),
        el("label", {}, ["Altura real (m)", numInput(1.7, 1.2, 2.2, 0.01, (h) => (userHeightM = h))]),
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "secondary", onclick: () => { cal.mirror = !cal.mirror; mapper.reset(); toast(`Reflexión: ${cal.mirror ? "espejo" : "directo"}. Levantá la mano derecha para verificar.`); } }, ["E · Corregir espejo (levantá mano derecha)"]),
        el("button", { class: "secondary", onclick: () => { cal.lateralEnabled = !cal.lateralEnabled; toast(`Desplazamiento lateral: ${cal.lateralEnabled ? "ON (aprox.)" : "OFF"}`); } }, ["Lateral aprox."]),
      ]),
      el("div", { id: "ql-metrics", class: "metrics" }),
      el("p", { class: "muted", text: "Pellizco con la mano izquierda: mostrar/ocultar este panel." }),
    ]);
    applyModeLabel();
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

  let userHeightM = 1.7;
  const overlayTimers: number[] = [];

  function setPhoneManual(distance?: number, directionDeg?: number): void {
    if (!scene || !userPos) {
      toast("Primero calibrá tu posición (A).");
      return;
    }
    const vp = scene.readViewerPose();
    const d = distance ?? (phonePos ? phonePos.distanceTo(userPos) : 2);
    const deg = directionDeg ?? 0;
    const rad = (deg * Math.PI) / 180;
    // Rotate the viewer forward by `deg` around up, project to floor.
    const fwd = vp.forwardXZ.clone();
    const cos = Math.cos(rad);
    const sin = Math.sin(rad);
    const dir = new Vector3(fwd.x * cos - fwd.z * sin, 0, fwd.x * sin + fwd.z * cos).normalize();
    phonePos = userPos.clone().add(dir.multiplyScalar(d));
    phonePos.y = scene.floorY;
    recomputeFrame();
  }

  function captureReference(): void {
    if (placement.mode === "overlay") {
      // Full recalibrate: re-solve scale from head + both hands AND re-aim/re-center.
      auto.has = false;
      resetAnchor();
      const ok = calibrateScale();
      toast(ok ? `Escala ×${auto.scale.toFixed(2)}. Mirá al frente: fija orientación.` : "Mostrá ambas manos al visor para calibrar.");
      return;
    }
    const buffered = buffer.peek();
    if (!buffered) {
      toast("No hay pose recibida todavía.");
      return;
    }
    const prevLateral = cal.lateralEnabled;
    cal = PoseMapper.buildCalibration(buffered.pose, userHeightM, cal.mirror);
    cal.lateralEnabled = prevLateral; // preserve the lateral toggle across recalibration
    mapper.reset();
    skeleton?.resetRetained();
    toast(`Escala calibrada (×${cal.scale.toFixed(2)}).`);
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

function numInput(val: number, min: number, max: number, step: number, on: (v: number) => void): HTMLInputElement {
  const input = el("input", { type: "number", value: val, min, max, step }) as HTMLInputElement;
  input.addEventListener("input", () => {
    const n = Number(input.value);
    if (Number.isFinite(n)) on(n);
  });
  return input;
}
