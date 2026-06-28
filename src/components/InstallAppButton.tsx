import { useStore } from "@nanostores/react";
import { Download, Share } from "lucide-react";
import { useEffect, useState } from "react";
import { toast } from "react-toastify";

import { Button } from "@/components/ui/button";
import {
    appInstalled,
    installPromptEvent,
    isIos,
    isStandalone,
    promptInstall,
} from "@/lib/pwaInstall";
import { cn } from "@/lib/utils";

/**
 * "Install app" CTA for the landing. Renders nothing when the app is
 * already installed or the browser can't install it (e.g. desktop
 * Firefox). On Chrome/Edge/Android it fires the native install prompt; on
 * iOS Safari it explains the manual Share → "Add to Home Screen" flow,
 * since iOS has no programmatic prompt.
 */
export function InstallAppButton({ className }: { className?: string }) {
    const $evt = useStore(installPromptEvent);
    const $installed = useStore(appInstalled);
    // matchMedia / UA checks are client-only; resolve after mount.
    const [standalone, setStandalone] = useState(false);
    const [ios, setIos] = useState(false);
    useEffect(() => {
        setStandalone(isStandalone());
        setIos(isIos());
    }, []);

    if ($installed || standalone) return null;
    const canPrompt = Boolean($evt);
    // Nothing to offer on browsers that neither expose the prompt nor are
    // iOS (manual install) — hide rather than show a dead button.
    if (!canPrompt && !ios) return null;

    const handle = async () => {
        if (canPrompt) {
            const outcome = await promptInstall();
            if (outcome === "accepted") {
                toast.success("Installing Hide+Seek…", { autoClose: 2500 });
            }
            return;
        }
        // iOS manual flow.
        toast.info(
            "To install: tap the Share icon, then 'Add to Home Screen'.",
            { autoClose: 6000 },
        );
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
            {ios && !canPrompt ? (
                <Share className="w-4 h-4 mr-2" strokeWidth={2.5} />
            ) : (
                <Download className="w-4 h-4 mr-2" strokeWidth={2.5} />
            )}
            Install app
        </Button>
    );
}

export default InstallAppButton;
