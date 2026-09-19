import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { act, type ReactElement } from "react";
import { createRoot, type Root } from "react-dom/client";
import { RouterProvider } from "./router";
import { ToastProvider } from "./components/Toasts";

// React needs to know it is running under a test harness so act() is honoured.
(globalThis as unknown as { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

export async function render(ui: ReactElement, path = "/console/overview") {
  window.history.replaceState(null, "", path);
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  await act(async () => {
    root.render(
      <RouterProvider>
        <ToastProvider>{ui}</ToastProvider>
      </RouterProvider>
    );
  });
  await flush();
  return { container };
}

export async function cleanup() {
  for (const { root, container } of mounted.splice(0)) {
    await act(async () => root.unmount());
    container.remove();
  }
  document.body.innerHTML = "";
}

export async function flush(times = 3) {
  for (let i = 0; i < times; i += 1) {
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  }
}

export async function click(element: Element | null | undefined) {
  if (!element) throw new Error("click: element not found");
  await act(async () => {
    (element as HTMLElement).click();
  });
  await flush(1);
}

export async function type(element: Element | null | undefined, value: string) {
  if (!element) throw new Error("type: element not found");
  const proto =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : element instanceof HTMLSelectElement
        ? HTMLSelectElement.prototype
        : HTMLInputElement.prototype;
  await act(async () => {
    Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(element, value);
    element.dispatchEvent(new Event(element instanceof HTMLSelectElement ? "change" : "input", { bubbles: true }));
  });
}

export function button(container: ParentNode, text: string | RegExp): HTMLButtonElement | undefined {
  return [...container.querySelectorAll("button")].find((b) =>
    typeof text === "string" ? b.textContent?.trim().startsWith(text) : text.test(b.textContent ?? "")
  ) as HTMLButtonElement | undefined;
}

export const openDialog = (): HTMLDialogElement | null => document.querySelector("dialog[open]");

export async function selectTab(container: ParentNode, name: string) {
  const tab = [...container.querySelectorAll("[role=tab]")].find((t) => t.textContent?.trim() === name);
  await click(tab);
}

// --- axe ---------------------------------------------------------------------------------------
const require = createRequire(import.meta.url);
const axeSource = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

export interface AxeViolation {
  id: string;
  impact?: string | null;
  help: string;
  nodes: Array<{ target: string[] }>;
}

export async function runAxe(root: Element): Promise<AxeViolation[]> {
  if (!(window as unknown as { axe?: unknown }).axe) {
    // Injected <script> tags are not executed under vitest's jsdom; evaluate the bundle in the window directly.
    (0, eval)(axeSource);
  }
  const axe = (
    window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: AxeViolation[] }> } }
  ).axe;
  // jsdom has no layout engine, so colour-contrast is verified in the real-browser audit instead.
  const result = await axe.run(root, {
    runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "best-practice"] },
    rules: { "color-contrast": { enabled: false }, region: { enabled: false } }
  });
  return result.violations;
}
