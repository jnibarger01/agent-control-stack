import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { browserToolClassSchema } from "@agent-control-stack/work-items";
import { describe, expect, it } from "vitest";

type Json = { [key: string]: unknown };
const openapiPath = resolve(dirname(fileURLToPath(import.meta.url)), "../../../contracts/public/v1/openapi.json");

/** Every browser tool-class schema in the published OpenAPI document. */
function browserToolSchemas(node: unknown, found: Json[] = []): Json[] {
  if (Array.isArray(node)) for (const entry of node) browserToolSchemas(entry, found);
  else if (node && typeof node === "object") {
    const properties = (node as Json).properties as Json | undefined;
    if (properties && "allowedOrigins" in properties && "allowedApplications" in properties) found.push(node as Json);
    for (const value of Object.values(node)) browserToolSchemas(value, found);
  }
  return found;
}

describe("public contract: browser grant origin and application constraints", () => {
  const schemas = browserToolSchemas(JSON.parse(readFileSync(openapiPath, "utf8")));

  it("publishes the browser tool class with pattern and uniqueness constraints", () => {
    expect(schemas.length).toBeGreaterThan(0);
    for (const schema of schemas) {
      const properties = schema.properties as Record<string, { uniqueItems?: boolean; items: { pattern?: string } }>;
      for (const name of ["allowedOrigins", "allowedApplications"]) {
        expect(properties[name]!.uniqueItems, name).toBe(true);
        expect(typeof properties[name]!.items.pattern, name).toBe("string");
      }
    }
  });

  it("rejects in the published pattern what the gateway validator rejects", () => {
    const properties = schemas[0]!.properties as Record<string, { items: { pattern: string } }>;
    const origin = new RegExp(properties.allowedOrigins!.items.pattern, "u");
    const application = new RegExp(properties.allowedApplications!.items.pattern, "u");
    const runtime = (allowedOrigins: string[], allowedApplications: string[]) =>
      browserToolClassSchema.safeParse({ runtime: "browser", toolName: "cua", allowedOrigins, allowedApplications })
        .success;
    for (const bad of [
      "*",
      "https://*.example",
      "https://app.example/",
      "https://app.example/path",
      "https://u:p@app.example",
      "ftp://app.example",
      "https://app.example.",
      "https://bücher.example",
      "HTTPS://app.example"
    ]) {
      expect(origin.test(bad), bad).toBe(false);
      expect(runtime([bad], ["Chrome"]), bad).toBe(false);
    }
    for (const bad of ["*", "Chrome*", "Chr?me", "[Cc]hrome", "{a,b}", "My App", "Сhrome"]) {
      expect(application.test(bad), bad).toBe(false);
      expect(runtime(["https://app.example"], [bad]), bad).toBe(false);
    }
    for (const good of ["https://app.example", "http://127.0.0.1:3000", "https://admin.example:8443"]) {
      expect(origin.test(good), good).toBe(true);
      expect(runtime([good], ["Chrome"]), good).toBe(true);
    }
    expect(application.test("com.google.Chrome")).toBe(true);
  });
});
