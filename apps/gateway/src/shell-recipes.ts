import { ControlStackError } from "@agent-control-stack/shared";
import { z } from "zod";

const recipeIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);
const commandNameSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9._-]+$/u)
  .refine((value) => !value.includes("/") && !value.includes("\\"), "command must be a PATH command");
const unsafeTokenPattern = /[;&|`$<>(){}[\]!*?~\n\r'"\\\s]/u;
const forbiddenExecutables = new Set([
  "sudo",
  "su",
  "doas",
  "pkexec",
  "runas",
  "sh",
  "bash",
  "zsh",
  "dash",
  "ksh",
  "fish",
  "csh",
  "tcsh",
  "env",
  "nice",
  "nohup",
  "timeout",
  "xargs",
  "watch",
  "script"
]);

export const shellRecipeSchema = z
  .object({
    id: recipeIdSchema,
    description: z.string().min(1).max(512),
    command: commandNameSchema.refine((value) => !forbiddenExecutables.has(value), "command is not allowed for recipes"),
    args: z
      .array(
        z
          .string()
          .min(1)
          .max(512)
          .refine((value) => !unsafeTokenPattern.test(value), "recipe args must be single literal tokens")
      )
      .max(64)
      .default([]),
    cwd: z
      .string()
      .min(1)
      .max(4096)
      .refine((value) => value.startsWith("/"), "cwd must be absolute")
      .refine((value) => !/[\0\n\r]/u.test(value), "cwd contains an unsafe character"),
    timeout_ms: z.number().int().min(1_000).max(120_000).default(120_000)
  })
  .strict();

export type ShellRecipe = z.infer<typeof shellRecipeSchema>;

export const shellRecipeListInputSchema = z.object({}).strict();
export const shellRecipePreviewInputSchema = z.object({ id: recipeIdSchema }).strict();
export const shellRecipeRequestInputSchema = z
  .object({
    id: recipeIdSchema,
    reason: z.string().min(1).max(1_000).optional()
  })
  .strict();

export type ShellRecipeRegistry = ReadonlyMap<string, ShellRecipe>;

export function parseShellRecipesJson(raw: string | undefined): ShellRecipeRegistry {
  if (raw === undefined || raw.trim() === "") return new Map();

  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    throw new ControlStackError("shell_recipe_config_invalid", "ACS_SHELL_RECIPES_JSON must be valid JSON");
  }
  if (!Array.isArray(value)) {
    throw new ControlStackError("shell_recipe_config_invalid", "ACS_SHELL_RECIPES_JSON must be a JSON array");
  }

  const recipes = new Map<string, ShellRecipe>();
  for (const candidate of value) {
    const parsed = shellRecipeSchema.safeParse(candidate);
    if (!parsed.success) {
      throw new ControlStackError(
        "shell_recipe_config_invalid",
        `invalid shell recipe: ${parsed.error.issues.map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`).join("; ")}`
      );
    }
    if (recipes.has(parsed.data.id)) {
      throw new ControlStackError("shell_recipe_config_invalid", `duplicate shell recipe id: ${parsed.data.id}`);
    }
    recipes.set(parsed.data.id, parsed.data);
  }
  return recipes;
}

export function configuredShellRecipes(env: NodeJS.ProcessEnv = process.env): ShellRecipeRegistry {
  return parseShellRecipesJson(env.ACS_SHELL_RECIPES_JSON);
}

export function listShellRecipes(registry: ShellRecipeRegistry): { recipes: Array<Record<string, unknown>> } {
  return {
    recipes: [...registry.values()]
      .sort((left, right) => left.id.localeCompare(right.id))
      .map((recipe) => ({ id: recipe.id, description: recipe.description }))
  };
}

export function resolveShellRecipe(registry: ShellRecipeRegistry, id: string): ShellRecipe {
  const recipe = registry.get(id);
  if (!recipe) throw new ControlStackError("shell_recipe_not_found", `shell recipe not found: ${id}`);
  return recipe;
}

export function shellRecipeWorkItemInput(recipe: ShellRecipe, actor: string, reason?: string) {
  const command = [recipe.command, ...recipe.args];
  const commandLine = command.join(" ");
  return {
    title: `Shell recipe: ${recipe.id}`,
    requester: "agent" as const,
    requesterSubject: actor,
    status: "pending_policy" as const,
    intent: reason ? `${recipe.description} Reason: ${reason}` : recipe.description,
    target: { cwd: recipe.cwd },
    requestedActions: [
      {
        kind: "shell",
        description: recipe.description,
        params: {
          recipeId: recipe.id,
          cwd: recipe.cwd,
          command,
          write: true,
          tool: "start_process",
          arguments: {
            command: commandLine,
            cwd: recipe.cwd,
            timeout_ms: recipe.timeout_ms
          }
        }
      }
    ],
    risk: "high" as const
  };
}

export function publicRecipe(recipe: ShellRecipe): Record<string, unknown> {
  return {
    id: recipe.id,
    description: recipe.description,
    command: recipe.command,
    args: [...recipe.args],
    cwd: recipe.cwd,
    timeout_ms: recipe.timeout_ms
  };
}