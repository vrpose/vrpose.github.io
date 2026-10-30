import "./styles.css";
import { onRouteChange, parseHash, type Route } from "./router";
import { mountHome } from "./ui/home";
import { BUILD } from "./config";

const app = document.getElementById("app");
if (!app) throw new Error("#app no encontrado");

// Always-visible build stamp so it's obvious whether the page updated.
const badge = document.createElement("div");
badge.className = "build-badge mono";
badge.textContent = `build ${BUILD}`;
document.body.append(badge);

let cleanup: (() => void) | null = null;
let renderToken = 0;

// Mode modules are dynamically imported so each device only downloads what it
// needs: the phone never pulls in three.js, the Quest never pulls the
// MediaPipe loader.
async function render(route: Route): Promise<void> {
  const token = ++renderToken;
  cleanup?.();
  cleanup = null;
  app!.replaceChildren();

  if (route.path === "/camera") {
    const { mountCamera } = await import("./camera/cameraMode");
    if (token !== renderToken) return; // route changed while loading
    cleanup = mountCamera(app!, route);
  } else if (route.path === "/quest") {
    const { mountQuest } = await import("./quest/questMode");
    if (token !== renderToken) return;
    cleanup = mountQuest(app!, route);
  } else {
    cleanup = mountHome(app!);
  }
}

onRouteChange((r) => void render(r));
void render(parseHash());
