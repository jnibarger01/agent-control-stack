export type CompatibilityShape = {
  required: string[];
  properties: string[];
  propertyTypes: Record<string, string>;
  propertyEnums: Record<string, string[]>;
};

export type CompatibilitySurface = {
  operations: Record<string, CompatibilityShape>;
  tools: Record<string, CompatibilityShape>;
};

export function classifyBreakingChanges(previous: CompatibilitySurface, next: CompatibilitySurface): string[] {
  const breaks: string[] = [];
  compare("operation", previous.operations, next.operations);
  compare("tool", previous.tools, next.tools);
  return breaks.sort();

  function compare(
    kind: string,
    before: Record<string, CompatibilityShape>,
    after: Record<string, CompatibilityShape>
  ): void {
    for (const [name, oldShape] of Object.entries(before)) {
      const newShape = after[name];
      if (!newShape) {
        breaks.push(`${kind}-removed:${name}`);
        continue;
      }
      for (const property of oldShape.properties) {
        if (!newShape.properties.includes(property)) {
          breaks.push(`${kind}-property-removed:${name}:${property}`);
          continue;
        }
        if (oldShape.propertyTypes[property] !== newShape.propertyTypes[property]) {
          breaks.push(`${kind}-property-type-changed:${name}:${property}`);
        }
        for (const value of oldShape.propertyEnums[property] ?? []) {
          if (!(newShape.propertyEnums[property] ?? []).includes(value)) {
            breaks.push(`${kind}-enum-value-removed:${name}:${property}:${value}`);
          }
        }
      }
      for (const property of newShape.required) {
        if (!oldShape.required.includes(property)) breaks.push(`${kind}-required-added:${name}:${property}`);
      }
    }
  }
}
