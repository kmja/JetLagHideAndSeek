/**
 * SPA-navigation bridge for plain (non-component) modules.
 *
 * Modules like `multiplayer/store.ts` need to change routes (e.g. move a
 * player to `/h` when their role flips) but can't call React Router's
 * `useNavigate` hook. They used `window.location.assign(...)` — a FULL page
 * reload, which tears down the live multiplayer WebSocket and makes the client
 * re-apply the server snapshot over local state (the "settings don't carry
 * over / the lobby reloads when I pick hider" bug).
 *
 * A tiny bridge component inside the router registers `navigate` here
 * (`registerAppNavigate`); callers use `appNavigate(...)` and fall back to a
 * hard navigation only if the bridge isn't mounted yet.
 */
type NavFn = (to: string, opts?: { replace?: boolean }) => void;

let navFn: NavFn | null = null;

/** Called by the in-router bridge component to (de)register `navigate`. */
export function registerAppNavigate(fn: NavFn | null): void {
    navFn = fn;
}

/**
 * Soft-navigate within the SPA. Returns true if the bridge handled it, false
 * if no navigate is registered (caller should fall back to a hard nav).
 */
export function appNavigate(
    to: string,
    opts?: { replace?: boolean },
): boolean {
    if (!navFn) return false;
    try {
        navFn(to, opts);
        return true;
    } catch {
        return false;
    }
}
