import { el } from "./dom";
import { navigate } from "../router";

export function mountHome(container: HTMLElement): () => void {
  const page = el("div", { class: "page" }, [
    el("h1", { text: "VRPose" }),
    el("p", {
      text: "Espejo corporal en realidad mixta. Un celular estima tu pose y un visor Meta Quest dibuja un esqueleto que te refleja, colocado frente a ti.",
    }),
    el("div", { class: "choice-grid" }, [
      el("div", { class: "card" }, [
        el("h2", { text: "📷 Usar como cámara" }),
        el("p", {
          text: "Apoyá este teléfono de frente a vos. Procesa el video localmente y envía solo coordenadas al visor.",
        }),
        el("button", { onclick: () => navigate("/camera") }, ["Abrir modo cámara"]),
      ]),
      el("div", { class: "card" }, [
        el("h2", { text: "🥽 Usar con Meta Quest" }),
        el("p", {
          text: "Emparejá con el celular escaneando el QR, pegando el enlace o con el formulario, y entrá en realidad mixta.",
        }),
        el("button", { onclick: () => navigate("/quest") }, ["Abrir modo visor"]),
      ]),
    ]),
    el("div", { class: "card" }, [
      el("h3", { text: "Antes de empezar" }),
      el("p", {
        html:
          "El video <b>no se transmite</b> por la red: solo coordenadas de pose. La señalización usa un servicio externo (PeerServer Cloud). Según tu red puede hacer falta un servidor TURN. Ver el README.",
      }),
    ]),
    el("p", {
      class: "muted",
      html: '<span class="mono">Prototipo MVP · seguimiento monocular con limitaciones conocidas</span>',
    }),
  ]);
  container.append(page);
  return () => page.remove();
}
