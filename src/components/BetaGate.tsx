import { useStore } from "@nanostores/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { betaGateDisabled, betaUnlocked, checkBetaCode } from "@/lib/beta";
import { cn } from "@/lib/utils";

import { HideSeekMark } from "./JetLagLogo";

/**
 * Private-beta unlock gate. Renders the app underneath at all times and
 * overlays a non-dismissible Dialog until the access code is entered (or
 * the gate is disabled at build time). So the landing page shows behind
 * the prompt instead of being replaced by a full-screen gate. See
 * `@/lib/beta` for the (client-side-only) caveats.
 */
export function BetaGate({ children }: { children: React.ReactNode }) {
    const $unlocked = useStore(betaUnlocked);
    const [code, setCode] = useState("");
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(false);

    const locked = !betaGateDisabled && !$unlocked;

    const submit = async () => {
        if (!code.trim() || busy) return;
        setBusy(true);
        const ok = await checkBetaCode(code);
        setBusy(false);
        if (ok) betaUnlocked.set(true);
        else setError(true);
    };

    return (
        <>
            {children}
            <Dialog open={locked} onOpenChange={() => {}}>
                <DialogContent
                    closeIcon={false}
                    // Not dismissible — entering the code is the only way
                    // out, so swallow Esc / outside-click / pointer-down.
                    onEscapeKeyDown={(e) => e.preventDefault()}
                    onInteractOutside={(e) => e.preventDefault()}
                    onPointerDownOutside={(e) => e.preventDefault()}
                    // Sit above everything (app dialogs/drawers top out at
                    // ~1060), forced dark to match the landing art.
                    className={cn(
                        "dark z-[2000] sm:max-w-sm",
                        "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                        "flex flex-col items-center text-center gap-4 px-6 py-7",
                    )}
                    overlayClassName="z-[2000] bg-black/70 backdrop-blur-sm"
                >
                    <HideSeekMark size={48} />
                    <span className="inline-flex items-center rounded-full border border-jetlag-yellow/60 bg-jetlag-yellow/10 px-3 py-1 text-[10px] font-display font-extrabold uppercase tracking-[0.16em] text-jetlag-yellow">
                        Private beta
                    </span>
                    <DialogTitle className="font-display font-black uppercase text-lg tracking-tight">
                        Enter access code
                    </DialogTitle>
                    <DialogDescription className="text-sm leading-relaxed text-current/80">
                        This is a private beta. Enter your access code to
                        continue.
                    </DialogDescription>
                    <div className="w-full space-y-1.5 text-left">
                        <Input
                            value={code}
                            onChange={(e) => {
                                setCode(e.target.value);
                                setError(false);
                            }}
                            onKeyDown={(e) => {
                                if (e.key === "Enter") {
                                    e.preventDefault();
                                    submit();
                                }
                            }}
                            placeholder="Access code"
                            autoFocus
                            autoCapitalize="none"
                            autoCorrect="off"
                            spellCheck={false}
                            className={cn(error && "border-destructive")}
                        />
                        {error && (
                            <p className="text-xs text-destructive">
                                That code isn't right. Check with whoever
                                invited you.
                            </p>
                        )}
                    </div>
                    <Button
                        onClick={submit}
                        disabled={busy || !code.trim()}
                        className="w-full font-display font-extrabold uppercase tracking-[0.02em]"
                    >
                        {busy ? "Checking…" : "Enter"}
                    </Button>
                </DialogContent>
            </Dialog>
        </>
    );
}

export default BetaGate;
