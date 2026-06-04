import "@/styles/globals.css";
import "react-toastify/dist/ReactToastify.css";

import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import { App } from "./App";

// Service worker registration lives inside `<PWAUpdatePrompt />`
// — it owns the lifecycle so the "update ready" toast can react
// to it. Keep this entry file minimal.

const root = document.getElementById("root");
if (!root) throw new Error("#root element missing from index.html");
createRoot(root).render(
    <StrictMode>
        <App />
    </StrictMode>,
);
