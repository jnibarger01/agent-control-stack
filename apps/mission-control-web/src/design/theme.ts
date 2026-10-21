import { useCallback, useEffect, useState } from "react";

export type ThemeChoice = "system" | "light" | "dark";
const KEY = "acs-theme";

function read(): ThemeChoice {
  try {
    const v = window.localStorage.getItem(KEY);
    return v === "light" || v === "dark" ? v : "system";
  } catch {
    return "system";
  }
}

/** Theme choice is the only thing persisted client-side; storage failures degrade to "system". */
export function useTheme() {
  const [choice, setChoice] = useState<ThemeChoice>(read);
  useEffect(() => {
    const root = document.documentElement;
    if (choice === "system") root.removeAttribute("data-theme");
    else root.setAttribute("data-theme", choice);
    try {
      if (choice === "system") window.localStorage.removeItem(KEY);
      else window.localStorage.setItem(KEY, choice);
    } catch {
      /* storage unavailable: the choice still applies for this session */
    }
  }, [choice]);
  const cycle = useCallback(() => setChoice((c) => (c === "system" ? "dark" : c === "dark" ? "light" : "system")), []);
  return { choice, cycle };
}
