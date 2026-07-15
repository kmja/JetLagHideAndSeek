import { useStore } from "@nanostores/react";
import { Download } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    appInstalled,
    installPromptEvent,
    isStandalone,
    promptInstall,
} from "@/lib/pwaInstall";
import { cn } from "@/lib/utils";

/**
 * "Install app" CTA for the landing. v880: shown ONLY when the browser
 * exposes a real one-tap install prompt (`beforeinstallprompt` — Chrome /
 * Edge / Android and desktop Chromium). The old iOS-Safari branch popped a
 * manual "tap Share → Add to Home Screen" toast, which read as broken (it's
 * instructions, not an install), so that path was dropped — on browsers with
 * no programmatic install the button simply doesn't render, rather than
 * offering a dead/confusing action.
 */
export function InstallAppButton({ className }: { className?: string }) {
    const $evt = useStore(installPromptEvent);
    const $installed = useStore(appInstalled);
    // matchMedia is client-only; resolve after mount.
    const [standalone, setStandalone] = useState(false);
    useEffect(() => {
        setStandalone(isStandalone());
    }, []);

    if ($installed || standalone) return null;
    // Only offer the button where a real native prompt is available.
    if (!$evt) return null;

    const handle = async () => {
        const outcome = await promptInstall();
        if (outcome === "accepted") {
            toast.success("Installing Hide+Seek…", { autoClose: 2500 });
        }
    };

    return (
        <Button
            size="lg"
            variant="outline"
            onClick={handle}
            className={cn(
                "w-full font-display font-extrabold uppercase tracking-[0.02em]",
                className,
            )}
        >
            <Download className="w-4 h-4 mr-2" strokeWidth={2.5} />
            Install app
        </Button>
    );
}

export default InstallAppButton;
