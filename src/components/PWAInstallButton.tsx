import { CheckCircle2, Download } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Adds-to-home-screen affordance for the More panel. Listens for the
 * `beforeinstallprompt` event (fires on Chrome/Edge/Android when the
 * site meets PWA install criteria). If installed already, renders a
 * static "installed" chip instead.
 *
 * v891: shows ONLY a REAL one-tap install button (a captured
 * `beforeinstallprompt`) or the installed chip — otherwise nothing. The
 * old UA-sniffed "To install on iOS, tap Share → Add to Home Screen" text
 * hint was removed: it read as a dead/confusing note on any browser that
 * spoofs an iOS UA (e.g. Firefox desktop in responsive/mobile mode), and a
 * static instruction isn't an install action anyway. iOS Safari users can
 * still Add to Home Screen via the native Share sheet.
 */
type DeferredPrompt = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function PWAInstallButton() {
    const [prompt, setPrompt] = useState<DeferredPrompt | null>(null);
    const [installed, setInstalled] = useState(false);

    useEffect(() => {
        // Detect "already installed" via the standalone display-mode
        // media query and iOS's nav.standalone flag.
        const standalone =
            window.matchMedia?.("(display-mode: standalone)").matches ||
            (window.navigator as any).standalone === true;
        if (standalone) setInstalled(true);

        const onBeforeInstall = (e: Event) => {
            e.preventDefault();
            setPrompt(e as DeferredPrompt);
        };
        const onInstalled = () => {
            setInstalled(true);
            setPrompt(null);
        };
        window.addEventListener("beforeinstallprompt", onBeforeInstall);
        window.addEventListener("appinstalled", onInstalled);
        return () => {
            window.removeEventListener("beforeinstallprompt", onBeforeInstall);
            window.removeEventListener("appinstalled", onInstalled);
        };
    }, []);

    if (installed) {
        return (
            <div
                className={cn(
                    "w-full flex items-center justify-center gap-2",
                    "px-3 py-2 rounded-md",
                    "bg-success/10 border border-success/40",
                    "text-sm font-semibold text-success",
                )}
            >
                <CheckCircle2 className="w-4 h-4" />
                Installed as app
            </div>
        );
    }

    if (prompt) {
        return (
            <button
                type="button"
                onClick={async () => {
                    try {
                        await prompt.prompt();
                        await prompt.userChoice;
                    } catch (e) {
                        console.warn("Install prompt failed", e);
                    } finally {
                        setPrompt(null);
                    }
                }}
                className={cn(
                    "w-full flex items-center justify-center gap-2",
                    "px-3 py-2 rounded-md",
                    "bg-primary text-primary-foreground hover:bg-primary/90",
                    "text-sm font-semibold transition-colors",
                    "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                )}
            >
                <Download className="w-4 h-4" />
                Install Hide+Seek as app
            </button>
        );
    }

    // No captured install prompt (Firefox / iOS Safari / the site doesn't
    // meet criteria yet — often solves itself on a second visit). Stay
    // silent rather than show a button or hint that doesn't do anything.
    return null;
}

export default PWAInstallButton;
