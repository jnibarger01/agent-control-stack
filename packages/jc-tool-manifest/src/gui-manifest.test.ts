import { describe, it, expect } from "vitest";
import { jcToolContract } from "./manifest.js";
describe("Native GUI capability contract", () => {
  it("separates observation from approved input and does not expose a shell", () => {
    const observe = jcToolContract("gui_screenshot");
    const input = jcToolContract("gui_action");
    expect(observe).toMatchObject({
      scopes: ["gui.observe"],
      actionKind: "jc.gui.observe",
      requiresApproval: false,
      group: "gui",
      pathArguments: []
    });
    expect(input).toMatchObject({
      scopes: ["gui.input"],
      actionKind: "jc.gui.input",
      requiresApproval: true,
      group: "gui",
      pathArguments: []
    });
    expect(input?.argsSchema.safeParse({ action: "click", x: 5, y: 9 }).success).toBe(true);
    expect(input?.argsSchema.safeParse({ action: "click", x: -5, y: 9 }).success).toBe(false);
    expect(input?.argsSchema.safeParse({ action: "type", text: "x".repeat(2049) }).success).toBe(false);
    expect(input?.argsSchema.safeParse({ action: "type", text: "hi", command: "whoami" }).success).toBe(false);
    expect(input?.argsSchema.safeParse({ action: "key", text: "Return;rm" }).success).toBe(false);
  });
});
