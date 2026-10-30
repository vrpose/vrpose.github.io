// Tiny DOM helpers (no framework).

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (k === "class") node.className = String(v);
    else if (k === "text") node.textContent = String(v);
    else if (k === "html") node.innerHTML = String(v);
    else if (k.startsWith("on") && typeof v === "function") {
      node.addEventListener(k.slice(2).toLowerCase(), v as EventListener);
    } else if (v === true) {
      node.setAttribute(k, "");
    } else {
      node.setAttribute(k, String(v));
    }
  }
  for (const c of children) node.append(c);
  return node;
}

export function clear(node: HTMLElement): void {
  node.replaceChildren();
}

export type StatusKind = "wait" | "ok" | "warn" | "err";

export function statusPill(label: string, kind: StatusKind): HTMLElement {
  return el("span", { class: "status" }, [el("span", { class: `dot ${kind}` }), label]);
}
