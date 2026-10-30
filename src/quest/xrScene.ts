// WebXR immersive-AR scene with a desktop (non-XR) debug fallback.
//
// AR passthrough: we render with a transparent framebuffer (alpha:true,
// clear alpha 0) so the real environment shows through. We do NOT assume WebXR
// gives us passthrough camera *frames* — it does not; we only composite over
// the headset's own passthrough.

import {
  AmbientLight,
  DirectionalLight,
  Group,
  PerspectiveCamera,
  Scene,
  Vector3,
  WebGLRenderer,
  GridHelper,
  Line,
  LineSegments,
  BufferGeometry,
  LineBasicMaterial,
  Float32BufferAttribute,
  type BufferAttribute,
  type Matrix4,
} from "three";

// WebXR hand joint chains (per finger), used to draw debug lines.
const FINGER_CHAINS: string[][] = [
  ["wrist", "thumb-metacarpal", "thumb-phalanx-proximal", "thumb-phalanx-distal", "thumb-tip"],
  ["wrist", "index-finger-metacarpal", "index-finger-phalanx-proximal", "index-finger-phalanx-intermediate", "index-finger-phalanx-distal", "index-finger-tip"],
  ["wrist", "middle-finger-metacarpal", "middle-finger-phalanx-proximal", "middle-finger-phalanx-intermediate", "middle-finger-phalanx-distal", "middle-finger-tip"],
  ["wrist", "ring-finger-metacarpal", "ring-finger-phalanx-proximal", "ring-finger-phalanx-intermediate", "ring-finger-phalanx-distal", "ring-finger-tip"],
  ["wrist", "pinky-finger-metacarpal", "pinky-finger-phalanx-proximal", "pinky-finger-phalanx-intermediate", "pinky-finger-phalanx-distal", "pinky-finger-tip"],
];
const HAND_EDGES = FINGER_CHAINS.reduce((n, c) => n + (c.length - 1), 0); // 24

export interface ViewerPose {
  position: Vector3;
  /** Horizontal forward direction (XZ, normalised). */
  forwardXZ: Vector3;
}

export type FrameCallback = (tSec: number) => void;

export class XrScene {
  readonly scene = new Scene();
  readonly renderer: WebGLRenderer;
  readonly camera = new PerspectiveCamera(60, 1, 0.01, 50);
  readonly controllers: Group[] = [];
  readonly hands: Group[] = [];
  private handLines: { hand: Group; seg: LineSegments; pos: Float32Array }[] = [];
  private frameCbs: FrameCallback[] = [];
  private floorYValue = 0;
  private inXR = false;
  private grid: GridHelper;
  private container: HTMLElement;
  // desktop orbit state
  private orbit = { az: 0, el: 0.1, dist: 3, dragging: false, px: 0, py: 0 };

  constructor(container: HTMLElement) {
    this.container = container;
    this.renderer = new WebGLRenderer({ alpha: true, antialias: true });
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.xr.enabled = true;
    container.append(this.renderer.domElement);

    this.scene.add(new AmbientLight(0xffffff, 0.8));
    const dir = new DirectionalLight(0xffffff, 1.0);
    dir.position.set(1, 3, 2);
    this.scene.add(dir);

    // Debug-only floor grid (hidden in AR where the real floor is visible).
    this.grid = new GridHelper(6, 12, 0x4f9dff, 0x2a3344);
    this.scene.add(this.grid);

    this.camera.position.set(0, 1.5, 3);

    for (let i = 0; i < 2; i++) {
      const c = this.renderer.xr.getController(i);
      c.add(makeRayLine());
      bindHandedness(c);
      this.scene.add(c);
      this.controllers.push(c);

      // Hand-tracking space (joints populated when hand tracking is active).
      const h = this.renderer.xr.getHand(i);
      bindHandedness(h);
      this.scene.add(h);
      this.hands.push(h);

      // Debug finger lines (world space, drawn on top for visibility).
      const pos = new Float32Array(HAND_EDGES * 2 * 3);
      const geo = new BufferGeometry();
      geo.setAttribute("position", new Float32BufferAttribute(pos, 3));
      const seg = new LineSegments(
        geo,
        new LineBasicMaterial({ color: i === 0 ? 0x4f9dff : 0xff8a5c, depthTest: false, transparent: true }),
      );
      seg.frustumCulled = false;
      seg.renderOrder = 999;
      seg.visible = false;
      this.scene.add(seg);
      this.handLines.push({ hand: h, seg, pos });
    }

    this.setupDesktopOrbit();
    this.onResize();
    window.addEventListener("resize", this.onResize);
    this.renderer.setAnimationLoop(this.loop);
  }

  get floorY(): number {
    return this.floorYValue;
  }
  get isImmersive(): boolean {
    return this.inXR;
  }

  onFrame(cb: FrameCallback): void {
    this.frameCbs.push(cb);
  }

  static async supportsAR(): Promise<boolean> {
    const xr = (navigator as unknown as { xr?: XRSystem }).xr;
    if (!xr?.isSessionSupported) return false;
    try {
      return await xr.isSessionSupported("immersive-ar");
    } catch {
      return false;
    }
  }

  async enterAR(opts: { domOverlayRoot?: HTMLElement } = {}): Promise<void> {
    const xr = (navigator as unknown as { xr: XRSystem }).xr;
    const optionalFeatures = ["local-floor", "bounded-floor", "hand-tracking"];
    const init: Record<string, unknown> = { optionalFeatures };
    if (opts.domOverlayRoot) {
      optionalFeatures.push("dom-overlay");
      init.domOverlay = { root: opts.domOverlayRoot };
    }
    const session = await xr.requestSession("immersive-ar", init as XRSessionInit);
    // Prefer a floor-relative space; three.js falls back internally if the
    // device lacks local-floor.
    this.renderer.xr.setReferenceSpaceType("local-floor");
    await this.renderer.xr.setSession(session);
    this.inXR = true;
    this.grid.visible = false;
    this.floorYValue = 0; // local-floor puts the floor at y = 0
    session.addEventListener("end", () => {
      this.inXR = false;
      this.grid.visible = true;
    });
  }

  /** Current viewer (head) pose from the active camera. */
  readViewerPose(): ViewerPose {
    const cam = this.inXR ? this.renderer.xr.getCamera() : this.camera;
    const position = new Vector3();
    cam.getWorldPosition(position);
    const fwd = new Vector3();
    cam.getWorldDirection(fwd); // points where the camera looks (-Z world)
    const forwardXZ = new Vector3(fwd.x, 0, fwd.z);
    if (forwardXZ.lengthSq() < 1e-8) forwardXZ.set(0, 0, -1);
    forwardXZ.normalize();
    return { position, forwardXZ };
  }

  /**
   * World position of a wrist for the given handedness. Prefers the hand-tracking
   * 'wrist' joint; falls back to the controller position. Null if unavailable.
   */
  wristWorld(handedness: "left" | "right"): Vector3 | null {
    for (const h of this.hands) {
      if (h.userData.handedness !== handedness) continue;
      const joints = (h as unknown as { joints?: Record<string, { getWorldPosition: (v: Vector3) => Vector3; visible?: boolean }> }).joints;
      const wrist = joints?.["wrist"];
      if (wrist) {
        const v = new Vector3();
        wrist.getWorldPosition(v);
        if (Number.isFinite(v.x) && (v.x !== 0 || v.y !== 0 || v.z !== 0)) return v;
      }
    }
    for (const c of this.controllers) {
      if (c.userData.handedness !== handedness) continue;
      const v = new Vector3();
      c.getWorldPosition(v);
      if (v.x !== 0 || v.y !== 0 || v.z !== 0) return v;
    }
    return null;
  }

  /** Controller ray → intersection with the floor plane (y = floorY). */
  controllerFloorHit(index = 0): Vector3 | null {
    const c = this.controllers[index];
    if (!c) return null;
    const origin = new Vector3();
    c.getWorldPosition(origin);
    const dir = new Vector3(0, 0, -1).applyQuaternion(c.quaternion).normalize();
    if (Math.abs(dir.y) < 1e-4) return null;
    const tHit = (this.floorYValue - origin.y) / dir.y;
    if (tHit <= 0) return null;
    return origin.add(dir.multiplyScalar(tHit));
  }

  dispose(): void {
    window.removeEventListener("resize", this.onResize);
    this.teardownDesktopOrbit();
    this.renderer.setAnimationLoop(null);
    const session = this.renderer.xr.getSession();
    if (session) void session.end().catch(() => {});
    this.renderer.dispose();
    this.renderer.domElement.remove();
  }

  // --- internals ---
  private loop = (time: number) => {
    if (!this.inXR) this.applyDesktopCamera();
    this.updateHandLines();
    for (const cb of this.frameCbs) cb(time / 1000);
    this.renderer.render(this.scene, this.camera);
  };

  private updateHandLines(): void {
    const v = new Vector3();
    for (const hl of this.handLines) {
      const joints = (hl.hand as unknown as { joints?: Record<string, { matrixWorld: Matrix4 }> }).joints;
      if (!joints || !hl.hand.userData.handedness) {
        hl.seg.visible = false;
        continue;
      }
      let k = 0;
      let any = false;
      for (const chain of FINGER_CHAINS) {
        for (let j = 0; j < chain.length - 1; j++) {
          const a = joints[chain[j]];
          const b = joints[chain[j + 1]];
          if (a && b) {
            v.setFromMatrixPosition(a.matrixWorld);
            hl.pos[k++] = v.x; hl.pos[k++] = v.y; hl.pos[k++] = v.z;
            v.setFromMatrixPosition(b.matrixWorld);
            hl.pos[k++] = v.x; hl.pos[k++] = v.y; hl.pos[k++] = v.z;
            any = true;
          } else {
            // collapse missing edge to a point so no stray line is drawn
            for (let n = 0; n < 6; n++) hl.pos[k++] = 0;
          }
        }
      }
      hl.seg.visible = any;
      const attr = hl.seg.geometry.getAttribute("position") as BufferAttribute;
      (attr.array as Float32Array).set(hl.pos);
      attr.needsUpdate = true;
    }
  }

  private onResize = () => {
    const w = this.container.clientWidth || window.innerWidth;
    const h = this.container.clientHeight || window.innerHeight;
    this.renderer.setSize(w, h, false);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  };

  private applyDesktopCamera(): void {
    const { az, el, dist } = this.orbit;
    const target = new Vector3(0, 1, 0);
    this.camera.position.set(
      target.x + dist * Math.cos(el) * Math.sin(az),
      target.y + dist * Math.sin(el),
      target.z + dist * Math.cos(el) * Math.cos(az),
    );
    this.camera.lookAt(target);
  }

  private setupDesktopOrbit(): void {
    const dom = this.renderer.domElement;
    dom.addEventListener("pointerdown", this.onPointerDown);
    dom.addEventListener("pointermove", this.onPointerMove);
    dom.addEventListener("pointerup", this.onPointerUp);
    dom.addEventListener("wheel", this.onWheel, { passive: true });
  }
  private teardownDesktopOrbit(): void {
    const dom = this.renderer.domElement;
    dom.removeEventListener("pointerdown", this.onPointerDown);
    dom.removeEventListener("pointermove", this.onPointerMove);
    dom.removeEventListener("pointerup", this.onPointerUp);
    dom.removeEventListener("wheel", this.onWheel);
  }
  private onPointerDown = (e: PointerEvent) => {
    this.orbit.dragging = true;
    this.orbit.px = e.clientX;
    this.orbit.py = e.clientY;
  };
  private onPointerMove = (e: PointerEvent) => {
    if (!this.orbit.dragging) return;
    this.orbit.az -= (e.clientX - this.orbit.px) * 0.01;
    this.orbit.el = Math.max(-1.2, Math.min(1.2, this.orbit.el + (e.clientY - this.orbit.py) * 0.01));
    this.orbit.px = e.clientX;
    this.orbit.py = e.clientY;
  };
  private onPointerUp = () => {
    this.orbit.dragging = false;
  };
  private onWheel = (e: WheelEvent) => {
    this.orbit.dist = Math.max(1, Math.min(8, this.orbit.dist + Math.sign(e.deltaY) * 0.3));
  };
}

/** Track an input source's handedness on a controller/hand Object3D. */
function bindHandedness(obj: Group): void {
  const ev = obj as unknown as {
    addEventListener: (t: string, cb: (e: { data?: { handedness?: string } }) => void) => void;
    userData: { handedness?: string };
  };
  ev.addEventListener("connected", (e) => {
    ev.userData.handedness = e.data?.handedness;
  });
  ev.addEventListener("disconnected", () => {
    ev.userData.handedness = undefined;
  });
}

function makeRayLine(): Line {
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0, 0, -3], 3));
  return new Line(geo, new LineBasicMaterial({ color: 0x4f9dff }));
}
