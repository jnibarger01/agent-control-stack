/** Literal path-prefix scope check shared by dispatch (F6) and verification (F7). Forbidden wins. */
export function inScope(file: string, permitted: readonly string[], forbidden: readonly string[]): boolean {
  const within = (path: string, root: string) => path === root || path.startsWith(root + "/");
  if (file.length === 0 || file.startsWith("/") || file.split("/").some((part) => part === ".." || part === ".git")) {
    return false;
  }
  if (forbidden.some((root) => within(file, root))) return false;
  return permitted.some((root) => within(file, root));
}

export function outOfScope(files: readonly string[], permitted: readonly string[], forbidden: readonly string[]): string[] {
  return [...new Set(files.filter((file) => !inScope(file, permitted, forbidden)))].sort();
}
