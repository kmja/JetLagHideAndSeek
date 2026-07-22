import { Play, Square, Video } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";

/** mm:ss (or h:mm:ss) from a whole-second count. */
function formatClock(totalSeconds: number): string {
    const s = Math.max(0, Math.floor(totalSeconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    const pad = (n: number) => String(n).padStart(2, "0");
    return h > 0 ? `${h}:${pad(m)}:${pad(sec)}` : `${m}:${pad(sec)}`;
}

/**
 * A live rear-camera VIEWFINDER + stopwatch (Curse of the Bird Guide). The
 * hider uses it to time their bird film when CASTING; the seekers use the same
 * one to film for at least as long before they can CLEAR the curse. The camera
 * is a framing aid — the captured DURATION is the payload. Degrades to a plain
 * stopwatch (with a hint) when no camera is available.
 *
 * `active` gates camera acquisition (pass the dialog's open state). `onElapsed`
 * fires with the captured seconds when the timer is stopped. `targetSeconds`,
 * if given, shows a "beat 0:MM" goal + a met/not-met state.
 */
export function FilmViewfinder({
    active = true,
    targetSeconds,
    onElapsed,
    onReachTarget,
}: {
    active?: boolean;
    targetSeconds?: number;
    onElapsed?: (seconds: number) => void;
    /** Fired ONCE the moment a RUNNING timer passes `targetSeconds` — the
     *  timer auto-stops and this fires, so the seekers don't have to stop it
     *  themselves (Curse of the Bird Guide: the running film just has to reach
     *  the bar). No-op when `targetSeconds` is unset (the hider's cast timer). */
    onReachTarget?: () => void;
}) {
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const [cameraError, setCameraError] = useState(false);
    const [running, setRunning] = useState(false);
    const [elapsedMs, setElapsedMs] = useState(0);
    const [captured, setCaptured] = useState<number | null>(null);
    const startRef = useRef<number | null>(null);
    // Latest callbacks/target read via refs so the ticking interval effect can
    // depend only on `running` (inline callbacks would otherwise re-arm it).
    const onElapsedRef = useRef(onElapsed);
    const onReachTargetRef = useRef(onReachTarget);
    const targetRef = useRef(targetSeconds);
    useEffect(() => {
        onElapsedRef.current = onElapsed;
        onReachTargetRef.current = onReachTarget;
        targetRef.current = targetSeconds;
    });

    // Acquire the rear camera while active; stop the stream on close/unmount.
    useEffect(() => {
        if (!active) return;
        if (!navigator.mediaDevices?.getUserMedia) {
            setCameraError(true);
            return;
        }
        let cancelled = false;
        setCameraError(false);
        navigator.mediaDevices
            .getUserMedia({
                video: { facingMode: { ideal: "environment" } },
                audio: false,
            })
            .then((stream) => {
                if (cancelled) {
                    stream.getTracks().forEach((t) => t.stop());
                    return;
                }
                streamRef.current = stream;
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    void videoRef.current.play().catch(() => {});
                }
            })
            .catch(() => {
                if (!cancelled) setCameraError(true);
            });
        return () => {
            cancelled = true;
            streamRef.current?.getTracks().forEach((t) => t.stop());
            streamRef.current = null;
            if (videoRef.current) videoRef.current.srcObject = null;
        };
    }, [active]);

    // Drive the live stopwatch display while running. When a target is set and
    // the RUNNING timer reaches it, auto-stop + report + fire onReachTarget so
    // the seekers don't have to stop it themselves.
    useEffect(() => {
        if (!running) return;
        const id = window.setInterval(() => {
            if (startRef.current == null) return;
            const ms = Date.now() - startRef.current;
            setElapsedMs(ms);
            const target = targetRef.current;
            if (target != null && ms / 1000 >= target) {
                const secs = Math.round(ms / 1000);
                setRunning(false);
                setCaptured(secs);
                onElapsedRef.current?.(secs);
                onReachTargetRef.current?.();
            }
        }, 200);
        return () => window.clearInterval(id);
    }, [running]);

    const start = () => {
        startRef.current = Date.now();
        setElapsedMs(0);
        setCaptured(null);
        setRunning(true);
    };
    const stop = () => {
        setRunning(false);
        const secs = Math.round(
            (Date.now() - (startRef.current ?? Date.now())) / 1000,
        );
        setCaptured(secs);
        onElapsed?.(secs);
    };
    const reset = () => {
        setRunning(false);
        setCaptured(null);
        setElapsedMs(0);
        startRef.current = null;
    };

    const shownSecs = captured != null ? captured : elapsedMs / 1000;
    const met =
        targetSeconds == null || (captured != null && captured >= targetSeconds);

    return (
        <div className="flex flex-col items-center gap-2">
            {cameraError ? (
                <p className="text-[11px] text-muted-foreground text-center max-w-xs leading-snug">
                    Camera unavailable — point your phone&apos;s own camera at
                    the bird and use the timer below.
                </p>
            ) : (
                <div className="relative w-full max-w-xs aspect-video overflow-hidden rounded-lg border border-border bg-black">
                    <video
                        ref={videoRef}
                        playsInline
                        muted
                        autoPlay
                        className="w-full h-full object-cover"
                    />
                    {running && (
                        <div className="absolute top-2 left-2 flex items-center gap-1.5 rounded-full bg-black/60 px-2 py-0.5 text-[11px] font-semibold text-white">
                            <span className="w-2 h-2 rounded-full bg-red-500 animate-pulse" />
                            REC
                        </div>
                    )}
                </div>
            )}
            <div className="font-inter-tight font-black tabular-nums text-4xl">
                {formatClock(shownSecs || 0)}
            </div>
            {running ? (
                <Button
                    type="button"
                    size="sm"
                    variant="destructive"
                    onClick={stop}
                    className="gap-1.5"
                >
                    <Square className="w-4 h-4" />
                    Stop timer
                </Button>
            ) : captured != null ? (
                <div className="flex flex-col items-center gap-1">
                    <p
                        className={
                            met
                                ? "text-xs text-success font-semibold"
                                : "text-xs text-destructive font-semibold"
                        }
                    >
                        Filmed {formatClock(captured)}
                        {targetSeconds != null &&
                            (met
                                ? " — long enough."
                                : ` — need ${formatClock(targetSeconds)}.`)}
                    </p>
                    <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={reset}
                        className="h-auto py-1 text-[11px]"
                    >
                        Redo
                    </Button>
                </div>
            ) : (
                <>
                    <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        onClick={start}
                        className="gap-1.5"
                    >
                        <Play className="w-4 h-4" />
                        Start timer
                    </Button>
                    <p className="text-[11px] text-muted-foreground leading-snug text-center inline-flex items-center gap-1">
                        <Video className="w-3 h-3" />
                        {targetSeconds != null
                            ? `Film a bird for at least ${formatClock(targetSeconds)}.`
                            : "Time your filming."}
                    </p>
                </>
            )}
        </div>
    );
}

export default FilmViewfinder;
