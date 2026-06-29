import { CheckCircle2, Download, Smartphone } from "lucide-react";
import { useEffect, useState } from "react";

import { cn } from "@/lib/utils";

/**
 * Adds-to-home-screen affordance for the More panel. Listens for the
 * `beforeinstallprompt` event (fires on Chrome/Edge/Android when the
 * site meets PWA install criteria). If installed already, renders a
 * static "installed" chip instead.
 *
 * On iOS/Safari the install flow can't be triggered programmatically
 * — the user has to use the Share sheet → "Add to Home Screen". For
 * those browsers we show a short note pointing them at that path.
 */
type DeferredPrompt = Event & {
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export function PWAInstallButton() {
    const [prompt, setPrompt] = useState<DeferredPrompt | null>(null);
    const [installed, setInstalled] = useState(false);
    const [isIos, setIsIos] = useState(false);

    useEffect(() => {
        // Detect "already installed" via the standalone display-mode
        // media query and iOS's nav.standalone flag.
        const standalone =
            window.matchMedia?.("(display-mode: standalone)").matches ||
            (window.navigator as any).standalone === true;
        if (standalone) setInstalled(true);

        // iOS Safari doesn't fire beforeinstallprompt — sniff the UA
        // so we can fall back to a "use Share → Add to Home Screen"
        // hint instead of leaving the button doing nothing.
        const ua = window.navigator.userAgent || "";
        const ios = /iPad|iPhone|iPod/.test(ua) && !(window as any).MSStream;
        setIsIos(ios);

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

    if (isIos) {
        return (
            <div
                className={cn(
                    "w-full flex items-start gap-2 px-3 py-2 rounded-md",
                    "bg-secondary border border-border text-xs",
                    "text-muted-foreground leading-snug",
                )}
            >
                <Smartphone className="w-4 h-4 shrink-0 mt-0.5 text-primary" />
                <span>
                    To install on iOS, tap{" "}
                    <span className="font-semibold text-foreground">
                        Share
                    </span>{" "}
                    →{" "}
                    <span className="font-semibold text-foreground">
                        Add to Home Screen
                    </span>
                    .
                </span>
            </div>
        );
    }

    // Browser hasn't fired the install prompt yet (or the site
    // doesn't meet criteria yet — usually solves itself after a
    // second visit). Stay silent rather than show a button that
    // doesn't work.
    return null;
}

export default PWAInstallButton;
