import { persistentAtom } from "@nanostores/persistent";
import { atom } from "nanostores";

/**
 * Three-state theme preference, persisted to localStorage.
 *
 *   - "system": follow the OS's `prefers-color-scheme`. Default for
 *     first-time users. The app re-reacts to OS-level changes so
 *     macOS / iOS / Android auto-switching at sunset just works.
 *   - "light" / "dark": explicit override, locked regardless of OS.
 *
 * The corresponding `class="light"` / `class="dark"` is applied to the
 * `<html>` element by `applyTheme()` — Tailwind's `darkMode: "class"`
 * config keys off that, and shadcn's `:root` / `.light` / `.dark` CSS
 * variable sets resolve from there. (`<body>`'s old hard-coded
 * `class="dark"` is removed in the same change so the new system can
 * write to the html element without fighting it.)
 */
export type ThemePreference = "system" | "light" | "dark";

/** What the user picked. */
export const themePreference = persistentAtom<ThemePreference>(
    "jlhs:theme",
    "system",
    {
        encode: (v) => v,
        decode: (v) =>
            v === "light" || v === "dark" || v === "system" ? v : "system",
    },
);

/** Currently-rendered mode, after resolving `system` against the OS.
 *  Volatile — derived from `themePreference` + the system query, no
 *  point persisting. UI components useStore() this to mirror the
 *  active mode in their copy (icons, labels, etc.). */
export const resolvedTheme = atom<"light" | "dark">("dark");

function systemPrefersDark(): boolean {
    if (typeof window === "undefined") return true;
    try {
        return window.matchMedia("(prefers-color-scheme: dark)").matches;
    } catch {
        return true;
    }
}

function resolve(pref: ThemePreference): "light" | "dark" {
    if (pref === "system") return systemPrefersDark() ? "dark" : "light";
    return pref;
}

/** Apply the resolved theme to the <html> element. Idempotent. */
function applyToDom(mode: "light" | "dark") {
    if (typeof document === "undefined") return;
    const html = document.documentElement;
    html.classList.toggle("dark", mode === "dark");
    html.classList.toggle("light", mode === "light");
    // Helps the browser theme-color (status bar tint on mobile) match.
    html.style.colorScheme = mode;
}

let installed = false;

/**
 * Boot the theme system. Idempotent — calling more than once is safe
 * (subsequent calls are no-ops). Wired in at app entry (main.tsx) so
 * the initial paint happens with the right class already on `<html>`.
 */
export function installTheme(): void {
    if (installed) return;
    installed = true;
    const sync = () => {
        const pref = themePreference.get();
        const mode = resolve(pref);
        applyToDom(mode);
        resolvedTheme.set(mode);
    };
    sync();
    themePreference.subscribe(sync);
    if (typeof window !== "undefined") {
        try {
            const mq = window.matchMedia("(prefers-color-scheme: dark)");
            const onChange = () => {
                if (themePreference.get() === "system") sync();
            };
            // Newer browsers use addEventListener; older Safari uses
            // addListener. Try both for compatibility.
            if (typeof mq.addEventListener === "function") {
                mq.addEventListener("change", onChange);
            } else if (
                typeof (mq as MediaQueryList & {
                    addListener?: (cb: () => void) => void;
                }).addListener === "function"
            ) {
                (mq as MediaQueryList & {
                    addListener: (cb: () => void) => void;
                }).addListener(onChange);
            }
        } catch {
            /* matchMedia unavailable — stay on the persisted/default */
        }
    }
}
