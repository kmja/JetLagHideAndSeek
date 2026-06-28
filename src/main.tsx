import "@/styles/globals.css";
import "react-toastify/dist/ReactToastify.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

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

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");
createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
