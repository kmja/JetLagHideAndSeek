import {
    Check,
    Crop,
    Redo2,
    RotateCcw,
    SquareDashedBottom,
    Undo2,
    X,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";

import { Button } from "@/components/ui/button";
import {
    Dialog,
    DialogContent,
    DialogDescription,
    DialogFooter,
    DialogTitle,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

/** A rectangle in normalized [0..1] coordinates. */
interface NormRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

/**
 * One non-destructive edit. Coordinates are normalized to the ORIGINAL
 * image, so the whole stack can be replayed (or partly replayed, for
 * undo) without ever mutating the source pixels.
 *   - redact: a black box, in original-image coords.
 *   - crop: the resulting visible window, in original-image coords.
 */
type EditOp =
    | { type: "redact"; rect: NormRect }
    | { type: "crop"; view: NormRect };

type Mode = "redact" | "crop";

const FULL_VIEW: NormRect = { x: 0, y: 0, w: 1, h: 1 };

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

function rectFromPoints(
    a: { x: number; y: number },
    b: { x: number; y: number },
): NormRect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/** The current visible window in original coords = the last crop, or full. */
function viewFromOps(ops: EditOp[]): NormRect {
    let v = FULL_VIEW;
    for (const op of ops) if (op.type === "crop") v = op.view;
    return v;
}

/** Map a rect from current-view-normalized space into original coords. */
function viewToOriginal(s: NormRect, view: NormRect): NormRect {
    return {
        x: view.x + s.x * view.w,
        y: view.y + s.y * view.h,
        w: s.w * view.w,
        h: s.h * view.h,
    };
}

/** Map a rect from original coords into current-view-normalized space. */
function originalToView(r: NormRect, view: NormRect): NormRect {
    return {
        x: (r.x - view.x) / view.w,
        y: (r.y - view.y) / view.h,
        w: r.w / view.w,
        h: r.h / view.h,
    };
}

/**
 * Review / crop / censor step shown after the hider picks a photo, before
 * it's compressed and uploaded.
 *
 *  - **Black out**: drag to paint opaque black boxes over identifying
 *    detail (street/place names, signs, logos, plates).
 *  - **Crop**: drag a region and apply it to trim the photo down.
 *
 * Editing is fully **non-destructive**: every edit is an entry on a stack
 * replayed from the untouched original, so any crop or redaction can be
 * undone (and redone) in order, in any combination. The source pixels are
 * never mutated while editing.
 *
 * Only the FINAL exported file is flattened: on confirm the current view +
 * redactions are rendered to a fresh JPEG, so the seekers can't peel back
 * a redaction or recover cropped-out area. Reset clears the whole stack.
 */
export function PhotoCensorDialog({
    file,
    onConfirm,
    onCancel,
}: {
    file: File;
    onConfirm: (edited: File) => void;
    onCancel: () => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const originalRef = useRef<HTMLImageElement | null>(null);
    const startRef = useRef<{ x: number; y: number } | null>(null);

    const [ready, setReady] = useState(false);
    const [tick, setTick] = useState(0); // forces a repaint after a load
    const [mode, setMode] = useState<Mode>("redact");
    const [ops, setOps] = useState<EditOp[]>([]);
    const [redo, setRedo] = useState<EditOp[]>([]);
    const [drawing, setDrawing] = useState<NormRect | null>(null); // view coords
    const [cropSel, setCropSel] = useState<NormRect | null>(null); // view coords
    const [busy, setBusy] = useState(false);

    // Decode the picked file once. The original is never mutated — edits
    // are replayed onto a copy each render.
    useEffect(() => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            originalRef.current = img;
            setReady(true);
            setTick((t) => t + 1);
            URL.revokeObjectURL(url);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            onCancel();
        };
        img.src = url;
        return () => URL.revokeObjectURL(url);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file]);

    // Repaint: cropped region of the original, replayed redactions, then
    // the active in-progress drawing / crop overlay.
    const draw = useCallback(() => {
        const c = canvasRef.current;
        const img = originalRef.current;
        if (!c || !img) return;
        const ow = img.naturalWidth;
        const oh = img.naturalHeight;
        const view = viewFromOps(ops);
        const vwPx = view.w * ow;
        const vhPx = view.h * oh;
        const scale = Math.min(1, 720 / vwPx || 1);
        const cw = Math.max(1, Math.round(vwPx * scale));
        const ch = Math.max(1, Math.round(vhPx * scale));
        if (c.width !== cw) c.width = cw;
        if (c.height !== ch) c.height = ch;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, cw, ch);
        ctx.drawImage(img, view.x * ow, view.y * oh, vwPx, vhPx, 0, 0, cw, ch);

        ctx.fillStyle = "#000";
        for (const op of ops) {
            if (op.type !== "redact") continue;
            const r = originalToView(op.rect, view);
            ctx.fillRect(r.x * cw, r.y * ch, r.w * cw, r.h * ch);
        }
        if (mode === "redact" && drawing) {
            ctx.fillRect(
                drawing.x * cw,
                drawing.y * ch,
                drawing.w * cw,
                drawing.h * ch,
            );
        }

        if (mode === "crop" && cropSel && cropSel.w > 0 && cropSel.h > 0) {
            const s = cropSel;
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            ctx.fillRect(0, 0, cw, s.y * ch);
            ctx.fillRect(0, (s.y + s.h) * ch, cw, (1 - (s.y + s.h)) * ch);
            ctx.fillRect(0, s.y * ch, s.x * cw, s.h * ch);
            ctx.fillRect(
                (s.x + s.w) * cw,
                s.y * ch,
                (1 - (s.x + s.w)) * cw,
                s.h * ch,
            );
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.strokeRect(s.x * cw, s.y * ch, s.w * cw, s.h * ch);
        }
    }, [ops, drawing, cropSel, mode]);

    useEffect(() => {
        draw();
    }, [draw, ready, tick]);

    const toNorm = (e: React.PointerEvent) => {
        const c = canvasRef.current;
        if (!c) return { x: 0, y: 0 };
        const rect = c.getBoundingClientRect();
        return {
            x: clamp01((e.clientX - rect.left) / rect.width),
            y: clamp01((e.clientY - rect.top) / rect.height),
        };
    };

    const onPointerDown = (e: React.PointerEvent) => {
        e.preventDefault();
        (e.target as HTMLElement).setPointerCapture?.(e.pointerId);
        const p = toNorm(e);
        startRef.current = p;
        if (mode === "redact") setDrawing({ x: p.x, y: p.y, w: 0, h: 0 });
        else setCropSel({ x: p.x, y: p.y, w: 0, h: 0 });
    };

    const onPointerMove = (e: React.PointerEvent) => {
        if (!startRef.current) return;
        const r = rectFromPoints(startRef.current, toNorm(e));
        if (mode === "redact") setDrawing(r);
        else setCropSel(r);
    };

    const pushOp = (op: EditOp) => {
        setOps((prev) => [...prev, op]);
        setRedo([]); // a fresh edit invalidates the redo branch
    };

    const onPointerUp = () => {
        if (mode === "redact") {
            const d = drawing;
            setDrawing(null);
            // Ignore taps / hairline drags so a stray tap doesn't drop a dot.
            if (d && d.w > 0.012 && d.h > 0.012) {
                pushOp({
                    type: "redact",
                    rect: viewToOriginal(d, viewFromOps(ops)),
                });
            }
        }
        startRef.current = null;
    };

    const cropValid = !!cropSel && cropSel.w > 0.02 && cropSel.h > 0.02;

    const applyCrop = () => {
        if (!cropSel || !cropValid) return;
        pushOp({ type: "crop", view: viewToOriginal(cropSel, viewFromOps(ops)) });
        setCropSel(null);
        setMode("redact");
    };

    const undo = () => {
        setOps((prev) => {
            if (prev.length === 0) return prev;
            const last = prev[prev.length - 1];
            setRedo((r) => [...r, last]);
            return prev.slice(0, -1);
        });
        setDrawing(null);
        setCropSel(null);
    };

    const redoOp = () => {
        setRedo((prev) => {
            if (prev.length === 0) return prev;
            const next = prev[prev.length - 1];
            setOps((o) => [...o, next]);
            return prev.slice(0, -1);
        });
        setDrawing(null);
        setCropSel(null);
    };

    const resetAll = () => {
        setOps([]);
        setRedo([]);
        setDrawing(null);
        setCropSel(null);
        setMode("redact");
    };

    const handleConfirm = () => {
        const img = originalRef.current;
        if (!img || busy) return;
        setBusy(true);
        try {
            const ow = img.naturalWidth;
            const oh = img.naturalHeight;
            const view = viewFromOps(ops);
            const sw = view.w * ow;
            const sh = view.h * oh;
            const off = document.createElement("canvas");
            off.width = Math.max(1, Math.round(sw));
            off.height = Math.max(1, Math.round(sh));
            const ctx = off.getContext("2d");
            if (!ctx) {
                onCancel();
                return;
            }
            ctx.drawImage(
                img,
                view.x * ow,
                view.y * oh,
                sw,
                sh,
                0,
                0,
                off.width,
                off.height,
            );
            ctx.fillStyle = "#000";
            for (const op of ops) {
                if (op.type !== "redact") continue;
                const r = originalToView(op.rect, view);
                ctx.fillRect(
                    r.x * off.width,
                    r.y * off.height,
                    r.w * off.width,
                    r.h * off.height,
                );
            }
            off.toBlob(
                (blob) => {
                    if (!blob) {
                        setBusy(false);
                        onCancel();
                        return;
                    }
                    const name = file.name?.replace(/\.\w+$/, "") || "photo";
                    onConfirm(
                        new File([blob], `${name}.jpg`, { type: "image/jpeg" }),
                    );
                },
                "image/jpeg",
                // High quality — the upload pipeline does the real
                // downscale/compression; we just bake in the edits.
                0.95,
            );
        } catch {
            setBusy(false);
            onCancel();
        }
    };

    const redactionCount = ops.filter((o) => o.type === "redact").length;

    return (
        <Dialog
            open
            onOpenChange={(o) => {
                if (!o) onCancel();
            }}
        >
            <DialogContent
                // v869: this censor dialog is ALWAYS launched from INSIDE
                // another layer — the hider answer dialog (z-[1060]) or the
                // Questions drawer (vaul z-[1055]) — so at the shadcn default
                // z-[1050] it opened BEHIND them, invisible, while its
                // DismissableLayer froze the app (the "photo picker locks the
                // review dialog" bug, same class as v797/v800). Raise both
                // layers above every launcher.
                className={cn(
                    "z-[1070]",
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col gap-3 sm:max-w-lg max-h-[92vh]",
                )}
                overlayClassName="z-[1070]"
            >
                <DialogTitle className="font-poppins font-bold">
                    Review, crop &amp; censor
                </DialogTitle>
                <DialogDescription className="text-xs leading-snug">
                    {mode === "redact"
                        ? "Drag across the photo to black out anything identifying — street and place names, shop signs, logos, license plates."
                        : "Drag to select the area to keep, then Apply crop to trim away the rest."}{" "}
                    Every edit can be undone; only the photo you finally send
                    is flattened.
                </DialogDescription>

                {/* Mode switch */}
                <div className="grid grid-cols-2 gap-2">
                    <Button
                        type="button"
                        variant={mode === "redact" ? "default" : "outline"}
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                            setMode("redact");
                            setCropSel(null);
                        }}
                        disabled={busy}
                    >
                        <SquareDashedBottom className="w-4 h-4" />
                        Black out
                    </Button>
                    <Button
                        type="button"
                        variant={mode === "crop" ? "default" : "outline"}
                        size="sm"
                        className="gap-1.5"
                        onClick={() => {
                            setMode("crop");
                            setDrawing(null);
                        }}
                        disabled={busy}
                    >
                        <Crop className="w-4 h-4" />
                        Crop
                    </Button>
                </div>

                <div className="overflow-auto rounded-md">
                    <canvas
                        ref={canvasRef}
                        onPointerDown={onPointerDown}
                        onPointerMove={onPointerMove}
                        onPointerUp={onPointerUp}
                        onPointerCancel={onPointerUp}
                        className={cn(
                            "w-full h-auto touch-none select-none cursor-crosshair",
                            "rounded-md border border-border bg-black/30",
                        )}
                    />
                </div>

                {/* Context controls */}
                <div className="flex items-center justify-between gap-2 min-h-[2rem]">
                    <span className="text-[11px] text-muted-foreground">
                        {mode === "crop"
                            ? cropValid
                                ? "Tap Apply crop to trim."
                                : "Drag to select the keep area."
                            : redactionCount === 0
                              ? "No redactions yet (optional)."
                              : `${redactionCount} area${redactionCount > 1 ? "s" : ""} blacked out.`}
                    </span>
                    <div className="flex gap-2">
                        {mode === "crop" && (
                            <Button
                                type="button"
                                variant="secondary"
                                size="sm"
                                className="gap-1.5"
                                disabled={!cropValid || busy}
                                onClick={applyCrop}
                            >
                                <Crop className="w-3.5 h-3.5" />
                                Apply crop
                            </Button>
                        )}
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            disabled={ops.length === 0 || busy}
                            onClick={undo}
                            title="Undo last edit"
                        >
                            <Undo2 className="w-3.5 h-3.5" />
                            Undo
                        </Button>
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            disabled={redo.length === 0 || busy}
                            onClick={redoOp}
                            title="Redo"
                        >
                            <Redo2 className="w-3.5 h-3.5" />
                            Redo
                        </Button>
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1.5"
                            disabled={ops.length === 0 || busy}
                            onClick={resetAll}
                            title="Revert to the original photo"
                        >
                            <RotateCcw className="w-3.5 h-3.5" />
                            Reset
                        </Button>
                    </div>
                </div>

                <DialogFooter className="gap-2 sm:gap-2">
                    <Button
                        type="button"
                        variant="ghost"
                        className="gap-1.5"
                        onClick={onCancel}
                        disabled={busy}
                    >
                        <X className="w-4 h-4" />
                        Cancel
                    </Button>
                    <Button
                        type="button"
                        className="gap-1.5"
                        onClick={handleConfirm}
                        disabled={!ready || busy}
                    >
                        <Check className="w-4 h-4" />
                        {busy ? "Preparing…" : "Attach photo"}
                    </Button>
                </DialogFooter>
            </DialogContent>
        </Dialog>
    );
}
