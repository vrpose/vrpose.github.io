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
  BufferGeometry,
  LineBasicMaterial,
  Float32BufferAttribute,
} from "three";

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
      this.scene.add(c);
      this.controllers.push(c);
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
    for (const cb of this.frameCbs) cb(time / 1000);
    this.renderer.render(this.scene, this.camera);
  };

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

function makeRayLine(): Line {
  const geo = new BufferGeometry();
  geo.setAttribute("position", new Float32BufferAttribute([0, 0, 0, 0, 0, -3], 3));
  return new Line(geo, new LineBasicMaterial({ color: 0x4f9dff }));
}
