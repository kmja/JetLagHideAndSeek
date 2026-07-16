import "@/styles/globals.css";
import "react-toastify/dist/ReactToastify.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installDebugSecretTap } from "@/hooks/useDebugSecretTap";
import { installBodyPointerEventsGuard } from "@/lib/bodyPointerEventsGuard";
import { installSoundUnlock } from "@/lib/sound";
import { installTheme } from "@/lib/theme";
// Side-effect import: registers the `beforeinstallprompt` listener at
// startup so the landing's "Install app" button can offer the native
// prompt (the event can fire before the landing component mounts).
import "@/lib/pwaInstall";

import { App } from "./App";

// Service worker registration lives inside `<PWAUpdatePrompt />`
// — it owns the lifecycle so the "update ready" toast can react
// to it. Keep this entry file minimal.

// Apply the persisted/system theme to <html> BEFORE React mounts so
// the first paint is already in the right palette (no white-flash on
// dark-mode users, no dark-flash on light-mode users).
installTheme();

// Self-healing guard for the recurring stuck `body { pointer-events: none }`
// left by Radix modal layers that unmount abruptly / overlap (see the module
// docs). Installed once for the app lifetime; replaces the per-component
// band-aids. Runs outside React so it survives every route change.
installBodyPointerEventsGuard();

// Hidden developer gesture: 5 quick taps in the top-centre of the screen open
// the debug panel. Installed once, app-wide — there's no visible launcher.
installDebugSecretTap();

// Arm the Web Audio unlock so game-beat SFX (sound.ts) can play — browsers
// block audio until the first user gesture; this resumes the shared
// AudioContext on it. Installed once, outside React, so it survives routes.
installSoundUnlock();

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");
createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);

// Boot watchdog handshake (index.html). Reaching this line means the entry
// bundle executed and React is rendering — so cancel the blank-screen
// watchdog and clear its one-shot self-heal guard. If the entry chunk had
// 404'd (a stale service-worker shell referencing a replaced hash — the
// installed-PWA "blank screen" case), this code would never run and the
// watchdog would drop the SW + caches and reload into a fresh shell. Any
// failure AFTER this point is a lazy route chunk, handled by lazyWithRetry
// + the root MapErrorBoundary (a recover card, never a blank screen).
declare global {
    interface Window {
        __APP_BOOTED?: boolean;
        __cancelBootWatchdog?: () => void;
    }
}
window.__APP_BOOTED = true;
window.__cancelBootWatchdog?.();
