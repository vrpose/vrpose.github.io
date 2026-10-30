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
import { buildMirrorFrame, yawFacing } from "../math/transforms";
import { parsePairingUrl } from "./pairing";
import { hello, ping, reset, nowEpochMs, type ProtocolMessage } from "../protocol/messages";

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
  let pingTimer = 0;
  let disposed = false;

  const placement = {
    mode: "mirror" as "mirror" | "overlay",
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
        if (ev.userData.handedness === "left") {
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
      try {
        await scene.enterAR({ domOverlayRoot: overlay });
      } catch (e) {
        toast(`No se pudo entrar en AR: ${(e as Error).message}`);
      }
    }
  }

  function renderFrame(tSec: number): void {
    if (!scene || !skeleton) return;
    // In "overlay" mode the figure is anchored to the headset every frame so it
    // tracks your real position/orientation in the room (6DoF from WebXR).
    if (placement.mode === "overlay") anchorOverlay();
    const buffered = buffer.peek();
    const age = buffer.ageMs(nowEpochMs());
    if (!buffered || age > cfg.maxPoseAgeMs) {
      // No fresh data: dim rather than freeze as if live.
      skeleton.setGlobalOpacity(0.15);
      return;
    }
    skeleton.setGlobalOpacity(1);
    const mapped = mapper.map(buffered.pose, cal, tSec);
    skeleton.update(mapped.positions, mapped.confidence);
  }

  // Overlay anchor: root sits at the headset's floor-projected position, facing
  // the headset's forward direction. Feet rest on the floor (the mapper already
  // offsets them), head lands near yours when the scale is calibrated.
  function anchorOverlay(): void {
    if (!scene || !skeleton) return;
    const vp = scene.readViewerPose();
    const fwd = vp.forwardXZ;
    skeleton.root.position.set(
      vp.position.x + fwd.x * placement.forward,
      scene.floorY + placement.height,
      vp.position.z + fwd.z * placement.forward,
    );
    const q = yawFacing(fwd);
    if (placement.yaw) q.multiply(new Quaternion().setFromAxisAngle(new Vector3(0, 1, 0), placement.yaw));
    skeleton.root.quaternion.copy(q);
    skeleton.root.scale.setScalar(placement.scale);
  }

  function recomputeFrame(): void {
    if (!scene || !skeleton) return;
    if (placement.mode === "overlay") {
      anchorOverlay();
      return;
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
      // Mirror reflection applies in "mirror" mode; a self-overlay is direct.
      cal.mirror = m === "mirror";
      mapper.reset();
      skeleton?.resetRetained();
      applyModeLabel();
      recomputeFrame();
      toast(m === "overlay" ? "Overlay anclado al visor. Calibrá la escala (D) parado." : "Modo espejo.");
    };
    modeBtn.addEventListener("click", () => setMode(placement.mode === "mirror" ? "overlay" : "mirror"));

    const panel = el("div", { class: "card" }, [
      modeBtn,
      abRow,
      mirrorOnly,
      slider("Adelante/atrás (m)", -1, 1, 0.02, placement.forward, (v) => { placement.forward = v; recomputeFrame(); }),
      slider("Altura (m)", -1, 1, 0.01, placement.height, (v) => { placement.height = v; recomputeFrame(); }),
      slider("Escala", 0.5, 1.8, 0.01, placement.scale, (v) => { placement.scale = v; recomputeFrame(); }),
      slider("Rotación (rad)", -Math.PI, Math.PI, 0.02, placement.yaw, (v) => { placement.yaw = v; recomputeFrame(); }),
      el("div", { class: "row" }, [
        el("button", { class: "secondary", onclick: () => void captureReference() }, ["D · Capturar escala (parado)"]),
        el("label", {}, ["Altura real (m)", numInput(1.7, 1.2, 2.2, 0.01, (h) => (userHeightM = h))]),
      ]),
      el("div", { class: "row" }, [
        el("button", { class: "secondary", onclick: () => { cal.mirror = !cal.mirror; mapper.reset(); toast(`Reflexión: ${cal.mirror ? "espejo" : "directo"}. Levantá la mano derecha para verificar.`); } }, ["E · Corregir espejo (levantá mano derecha)"]),
        el("button", { class: "secondary", onclick: () => { cal.lateralEnabled = !cal.lateralEnabled; toast(`Desplazamiento lateral: ${cal.lateralEnabled ? "ON (aprox.)" : "OFF"}`); } }, ["Lateral aprox."]),
      ]),
      el("div", { id: "ql-metrics", class: "metrics" }),
      el("p", { class: "muted", text: "Pellizco con la mano izquierda: mostrar/ocultar este panel." }),
      el("button", { class: "ghost", onclick: () => void exitStage() }, ["Salir"]),
    ]);
    applyModeLabel();
    controlPanel = panel;
    host.append(panel);

    // live metrics in overlay
    const mTimer = window.setInterval(() => {
      const host2 = panel.querySelector("#ql-metrics");
      if (!host2) return;
      const age = buffer.ageMs(nowEpochMs());
      const r = rtt.rttMs;
      const stats = buffer.stats;
      host2.replaceChildren(
        metric("RTT", r == null ? "—" : `${r.toFixed(0)} ms`),
        metric("Antigüedad pose (local)", Number.isFinite(age) ? `${age.toFixed(0)} ms` : "—"),
        metric("Aceptadas", String(stats.accepted)),
        metric("Rechazadas (viejas)", String(stats.rejected)),
      );
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
    document.body.append(t);
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
