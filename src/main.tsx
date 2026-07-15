import "@/styles/globals.css";
import "react-toastify/dist/ReactToastify.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { installDebugSecretTap } from "@/hooks/useDebugSecretTap";
import { installBodyPointerEventsGuard } from "@/lib/bodyPointerEventsGuard";
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

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");
createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
