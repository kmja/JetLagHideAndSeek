import { atom } from "nanostores";

/**
 * PWA install plumbing for the "Install app" CTA on the landing.
 *
 * Chrome/Edge/Android fire a `beforeinstallprompt` event when the app
 * meets the install criteria (manifest + service worker + HTTPS). We must
 * `preventDefault()` it and stash the event so a button can call
 * `.prompt()` later from a user gesture. The listener is registered at
 * module-import time (this module is pulled in by the landing, which is in
 * the initial bundle) so we don't miss the event.
 *
 * iOS Safari has no such event — installation is the manual Share → "Add
 * to Home Screen" flow — so `isIos()` lets the UI show instructions
 * instead of a one-tap button.
 */

export interface BeforeInstallPromptEvent extends Event {
    readonly platforms: string[];
    prompt: () => Promise<void>;
    userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
}

/** The deferred prompt, or null when none is pending (not installable on
 *  this browser, already used, or already installed). */
export const installPromptEvent = atom<BeforeInstallPromptEvent | null>(null);

/** Flips true once the app reports it was installed. */
export const appInstalled = atom<boolean>(false);

if (typeof window !== "undefined") {
    window.addEventListener("beforeinstallprompt", (e) => {
        e.preventDefault();
        installPromptEvent.set(e as BeforeInstallPromptEvent);
    });
    window.addEventListener("appinstalled", () => {
        appInstalled.set(true);
        installPromptEvent.set(null);
    });
}

/** Already running as an installed app (standalone display mode)? */
export function isStandalone(): boolean {
    if (typeof window === "undefined") return false;
    return (
        window.matchMedia?.("(display-mode: standalone)").matches === true ||
        // iOS Safari's legacy flag.
        (window.navigator as unknown as { standalone?: boolean }).standalone ===
            true
    );
}

/** iOS/iPadOS Safari (where install is the manual Add-to-Home-Screen
 *  flow). Excludes Chrome/Firefox on iOS, which can't install at all. */
export function isIos(): boolean {
    if (typeof navigator === "undefined") return false;
    const ua = navigator.userAgent || "";
    const iDevice =
        /iPad|iPhone|iPod/.test(ua) ||
        // iPadOS 13+ reports as Mac with touch.
        (navigator.platform === "MacIntel" &&
            (navigator.maxTouchPoints ?? 0) > 1);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS/.test(ua);
    return iDevice && isSafari;
}

/** Trigger the native install prompt. Returns the outcome, or
 *  "unavailable" when there's no deferred prompt to use. */
export async function promptInstall(): Promise<
    "accepted" | "dismissed" | "unavailable"
> {
    const e = installPromptEvent.get();
    if (!e) return "unavailable";
    await e.prompt();
    const { outcome } = await e.userChoice;
    // A prompt can only be used once; drop it either way.
    installPromptEvent.set(null);
    return outcome;
}
