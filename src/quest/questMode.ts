import { Quaternion, Vector3 } from "three";
import { el, clear, statusPill, type StatusKind } from "../ui/dom";
import type { Route } from "../router";
import { resolveConfig, BUILD } from "../config";
import { connectToCamera, type Link } from "../net/peer";
import { QrScanner } from "./qrScanner";
import { XrScene } from "./xrScene";
import { SkeletonRenderer } from "./skeleton";
import { PoseMapper, defaultCalibration, type Calibration } from "./poseMapper";
import { LatestPoseBuffer } from "../protocol/queue";
import { RttMeter } from "../protocol/clock";
import { measureModelHeight, worldLandmarkToLocal } from "../math/transforms";
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
  // (see calibrateAlign), which makes a separate mirror mode unnecessary and
  // removed a source of back-to-front errors.
  const placement = {
    height: 0,
    scale: 1,
    yaw: 0, // manual fine-tune on top of the auto yaw
    forward: 0, // shift along the body's facing direction
  };
  let controlPanel: HTMLElement | null = null;
  let arOverlayRoot: HTMLElement | null = null;

  // Overlay auto-calibration, solved ONCE (D / right pinch) by aligning the two
  // WRISTS: pose LEFT/RIGHT wrist ↔ hand-tracking left/right wrist. Because the
  // hand correspondence is known and the phone films from the front (≤~60°), the
  // directed vector leftWrist→rightWrist fixes, unambiguously:
  //   - SCALE  = world wrist separation / pose wrist separation,
  //   - YAW    = rotation aligning that vector horizontally (gravity up kept, so
  //              the figure never tips and front/back is never flipped),
  //   - POS    = translation so the wrist MIDPOINT coincides.
  // The result is held so the pose's real wrists sit on the tracked hands.
  const auto = { scale: 1, yaw: new Quaternion(), pos: new Vector3(), has: false };

  // Position smoothing so a recalibration eases in rather than popping.
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
    // route by handedness: LEFT pinch flips the figure 180° (and toggles the DOM
    // panel where supported); RIGHT pinch / trigger recalibrates from the hands;
    // BOTH together exit AR. Handedness comes from the input source captured on
    // 'connected'. These events are not in three's typed Object3DEventMap.
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
          // Flip the figure 180° (fixes "facing backwards") AND toggle the DOM
          // panel for devices where dom-overlay does composite.
          flipFacing();
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
          // DOM can't be composited over AR on this device. The 3D HUD (in-scene)
          // shows status and the gesture legend instead, so this is non-fatal.
          scene?.setHud([
            `build ${BUILD}`,
            "Sin panel DOM en AR: usá gestos.",
            "· Pellizco izq: girar 180°",
            "· Pellizco der: recalibrar",
            "· Ambas manos: salir",
          ]);
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
    placeOverlay(tSec);
    skeleton.update(mapped.positions, mapped.confidence);
  }

  // Overlay placement: apply the held wrist-aligned transform (+ manual nudges).
  // No per-frame headset read, so head motion never drags the body ("neck
  // brace"), and yaw-only keeps it gravity-upright (never "feet on ceiling").
  const UP = new Vector3(0, 1, 0);
  function placeOverlay(tSec: number): void {
    if (!scene || !skeleton) return;
    if (!auto.has) calibrateAlign(); // lazy one-shot until both hands are seen
    const s = auto.scale * placement.scale;
    const q = auto.yaw.clone();
    if (placement.yaw) q.multiply(new Quaternion().setFromAxisAngle(UP, placement.yaw));
    skeleton.root.quaternion.copy(q);
    skeleton.root.scale.setScalar(s);

    const target = auto.pos.clone();
    target.y += placement.height;
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
      anchor.pos.lerp(target, 1 - Math.exp(-dt / 0.25)); // ease recalibration
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

  // One-shot alignment of the two wrists (pose ↔ hand tracking). See the `auto`
  // comment: known L/R correspondence + frontal camera make this unambiguous, so
  // the figure faces correctly (no 180° guesswork) and the wrists coincide.
  // Called on demand (D / right pinch), not every frame.
  function calibrateAlign(): boolean {
    if (!scene) return false;
    const wl = buffer.peek()?.pose.worldLandmarks;
    if (!wl || wl.length < POSE_LANDMARK_COUNT) return false;
    const LWw = scene.wristWorld("left");
    const RWw = scene.wristWorld("right");
    if (!LWw || !RWw) return false; // need both hands tracked
    const lw = worldLandmarkToLocal(wl[LM.LEFT_WRIST], cal.mirror);
    const rw = worldLandmarkToLocal(wl[LM.RIGHT_WRIST], cal.mirror);

    const sepLocal = lw.distanceTo(rw);
    const sepWorld = LWw.distanceTo(RWw);
    if (sepLocal < 1e-3 || sepWorld < 1e-3) return false;
    const s = Math.min(2.5, Math.max(0.3, sepWorld / sepLocal));

    // Yaw: rotate the pose's horizontal left→right wrist vector onto the real
    // one. Both lie in the XZ plane, so this quaternion is pure yaw.
    const dirLocal = new Vector3(rw.x - lw.x, 0, rw.z - lw.z);
    const dirWorld = new Vector3(RWw.x - LWw.x, 0, RWw.z - LWw.z);
    if (dirLocal.lengthSq() < 1e-6 || dirWorld.lengthSq() < 1e-6) return false;
    const q = new Quaternion().setFromUnitVectors(dirLocal.normalize(), dirWorld.normalize());

    // Translation: make the wrist midpoints coincide.
    const midLocal = lw.clone().add(rw).multiplyScalar(0.5);
    const midWorld = LWw.clone().add(RWw).multiplyScalar(0.5);
    const p = midWorld.clone().sub(midLocal.clone().multiplyScalar(s).applyQuaternion(q));

    auto.scale = s;
    auto.yaw = q;
    auto.pos = p;
    auto.has = true;
    placement.yaw = 0; // clear any manual 180° flip; auto now aims it
    resetAnchor();
    return true;
  }

  /** Which tracked hands the viewer currently sees (for on-device diagnostics). */
  function handsSeen(): "both" | "left" | "right" | "none" {
    if (!scene) return "none";
    const l = !!scene.wristWorld("left");
    const r = !!scene.wristWorld("right");
    return l && r ? "both" : l ? "left" : r ? "right" : "none";
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
        el("button", { class: "secondary", onclick: () => flipFacing() }, ["↻ Girar 180°"]),
        el("button", { class: "secondary", onclick: () => flipReflection() }, ["E · Corregir izq/der"]),
      ]),
      el("div", { id: "ql-metrics", class: "metrics" }),
      el("p", { class: "muted", text: "Pellizco izq: girar 180° · Pellizco der: recalibrar · Ambas manos: salir." }),
      el("p", { class: "muted mono", text: `build ${BUILD}` }),
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
      const hands = handsSeen();
      const handsLabel = { both: "ambas", left: "solo izq", right: "solo der", none: "ninguna" }[hands];
      if (host2) {
        host2.replaceChildren(
          metric("Orientación", auto.has ? "calibrada" : "sin calibrar"),
          metric("Manos (visor)", handsLabel),
          metric("RTT", r == null ? "—" : `${r.toFixed(0)} ms`),
          metric("Altura estimada", h == null ? "—" : `${h.toFixed(2)} m`),
          metric("Antigüedad pose (local)", Number.isFinite(age) ? `${age.toFixed(0)} ms` : "—"),
          metric("Rechazadas (viejas)", String(stats.rejected)),
        );
      }
      // Head-locked 3D HUD: visible in AR even without DOM dom-overlay support.
      scene?.setHud([
        `build ${BUILD}`,
        `Orientación: ${auto.has ? "calibrada" : "sin calibrar"} · ×${auto.scale.toFixed(2)}`,
        `Manos: ${handsLabel} · Altura ${h == null ? "—" : h.toFixed(2) + " m"}`,
        `RTT ${r == null ? "—" : r.toFixed(0) + " ms"}`,
        "· Pellizco izq: girar 180°",
        "· Pellizco der: recalibrar",
        "· Ambas manos: salir",
      ]);
      // Report what the viewer computed back to the phone over the same channel.
      if (link?.state === "open") {
        link.send(status("metrics", undefined, { heightM: h ?? undefined, rttMs: r ?? undefined }));
      }
    }, 500);
    overlayTimers.push(mTimer);
  }

  const overlayTimers: number[] = [];

  // Recalibrate: align both wrists (pose ↔ hand tracking).
  function captureReference(): void {
    auto.has = false;
    const ok = calibrateAlign();
    toast(ok ? `Calibrado · escala ×${auto.scale.toFixed(2)}.` : "Mostrá ambas manos al visor para calibrar.");
  }

  // Rotate the figure 180° about vertical (fixes "facing backwards"). Keeps the
  // manual yaw within (-π, π].
  function flipFacing(): void {
    placement.yaw += Math.PI;
    if (placement.yaw > Math.PI) placement.yaw -= 2 * Math.PI;
    toast("Giré 180°.");
  }

  // Flip the left/right correspondence (reflection). If the figure faces the
  // wrong way or mirrors your hands, toggling this and re-solving fixes it.
  function flipReflection(): void {
    cal.mirror = !cal.mirror;
    mapper.reset();
    skeleton?.resetRetained();
    auto.has = false; // re-solve under the new correspondence
    const ok = calibrateAlign();
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
