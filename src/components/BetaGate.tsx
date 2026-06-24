import { useStore } from "@nanostores/react";
import { useState } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { betaGateDisabled, betaUnlocked, checkBetaCode } from "@/lib/beta";
import { cn } from "@/lib/utils";

import { HideSeekMark, HideSeekWordmark } from "./JetLagLogo";

/**
 * Private-beta unlock screen. Wraps the whole app: until the access code
 * is entered (or the gate is disabled at build time), nothing else
 * mounts. See `@/lib/beta` for the (client-side-only) caveats.
 */
export function BetaGate({ children }: { children: React.ReactNode }) {
    const $unlocked = useStore(betaUnlocked);
    const [code, setCode] = useState("");
    const [error, setError] = useState(false);
    const [busy, setBusy] = useState(false);

    if (betaGateDisabled || $unlocked) return <>{children}</>;

    const submit = async () => {
        if (!code.trim() || busy) return;
        setBusy(true);
        const ok = await checkBetaCode(code);
        setBusy(false);
        if (ok) betaUnlocked.set(true);
        else setError(true);
    };

    return (
        <div
            className={cn(
                // v472: force dark so the gate matches the dark landing /
                // box art, regardless of the app theme.
                "dark",
                "fixed inset-0 z-[2000] flex justify-center overflow-y-auto",
                "bg-[hsl(var(--sidebar-background))] text-[hsl(var(--sidebar-foreground))]",
                "pt-[env(safe-area-inset-top)] pb-[env(safe-area-inset-bottom)]",
            )}
            role="dialog"
            aria-modal="true"
            aria-label="Private beta"
        >
            <div className="w-full sm:max-w-sm flex flex-col items-center text-center px-6 pt-16 gap-5">
                <HideSeekMark size={64} />
                <HideSeekWordmark size="lg" />
                <span className="inline-flex items-center rounded-full border border-jetlag-yellow/60 bg-jetlag-yellow/10 px-3 py-1 text-[10px] font-display font-extrabold uppercase tracking-[0.16em] text-jetlag-yellow">
                    Private beta
                </span>
                <p className="text-sm leading-relaxed text-current/80">
                    This is a private beta. Enter your access code to continue.
                </p>
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
                            That code isn't right. Check with whoever invited
                            you.
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
            </div>
        </div>
    );
}

export default BetaGate;
