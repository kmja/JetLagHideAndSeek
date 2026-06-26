import {
    Check,
    Crop,
    Eraser,
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

/** A rectangle in normalized [0..1] coordinates of the working image. */
interface NormRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

type Mode = "redact" | "crop";

const clamp01 = (n: number) => Math.max(0, Math.min(1, n));

/** Build a normalized rect from two corner points (any drag direction). */
function rectFromPoints(
    a: { x: number; y: number },
    b: { x: number; y: number },
): NormRect {
    const x = Math.min(a.x, b.x);
    const y = Math.min(a.y, b.y);
    return { x, y, w: Math.abs(a.x - b.x), h: Math.abs(a.y - b.y) };
}

/**
 * Review / crop / censor step shown after the hider picks a photo, before
 * it's compressed and uploaded.
 *
 *  - **Black out**: drag to paint opaque black boxes over identifying
 *    detail (street/place names, signs, logos, plates).
 *  - **Crop**: drag a region and apply it to trim the photo down.
 *
 * Both edits are **destructive**: redaction boxes are filled into the
 * pixels and crop discards everything outside the region. On confirm the
 * working image is re-encoded to a JPEG, so nothing covered or cropped
 * survives in the file that gets sent — it's not a peel-back overlay.
 *
 * Edits are optional; confirming an untouched photo is a plain
 * review-and-send. Reset reverts to the originally picked photo.
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
    const imgRef = useRef<HTMLImageElement | null>(null);
    const naturalRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
    const startRef = useRef<{ x: number; y: number } | null>(null);

    const [ready, setReady] = useState(false);
    const [tick, setTick] = useState(0); // forces a repaint after a load
    const [mode, setMode] = useState<Mode>("redact");
    const [rects, setRects] = useState<NormRect[]>([]); // redaction boxes
    const [drawing, setDrawing] = useState<NormRect | null>(null);
    const [cropSel, setCropSel] = useState<NormRect | null>(null);
    const [edited, setEdited] = useState(false); // any crop applied?
    const [busy, setBusy] = useState(false);

    /** Decode an image source into the working refs and size the preview. */
    const loadSource = useCallback(
        (src: string, revoke?: () => void) => {
            const img = new Image();
            img.onload = () => {
                imgRef.current = img;
                naturalRef.current = {
                    w: img.naturalWidth,
                    h: img.naturalHeight,
                };
                const c = canvasRef.current;
                if (c) {
                    const maxW = 720;
                    const scale = Math.min(1, maxW / img.naturalWidth || 1);
                    c.width = Math.max(1, Math.round(img.naturalWidth * scale));
                    c.height = Math.max(
                        1,
                        Math.round(img.naturalHeight * scale),
                    );
                }
                setRects([]);
                setCropSel(null);
                setDrawing(null);
                setReady(true);
                setTick((t) => t + 1);
                revoke?.();
            };
            img.onerror = () => {
                revoke?.();
                onCancel();
            };
            img.src = src;
        },
        [onCancel],
    );

    // Initial decode of the picked file.
    useEffect(() => {
        const url = URL.createObjectURL(file);
        loadSource(url, () => URL.revokeObjectURL(url));
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file]);

    // Repaint: base image, redaction boxes, then the active crop overlay.
    const draw = useCallback(() => {
        const c = canvasRef.current;
        const img = imgRef.current;
        if (!c || !img) return;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.clearRect(0, 0, c.width, c.height);
        ctx.drawImage(img, 0, 0, c.width, c.height);

        ctx.fillStyle = "#000";
        const boxes =
            mode === "redact" && drawing ? [...rects, drawing] : rects;
        for (const r of boxes) {
            ctx.fillRect(
                r.x * c.width,
                r.y * c.height,
                r.w * c.width,
                r.h * c.height,
            );
        }

        if (mode === "crop" && cropSel && cropSel.w > 0 && cropSel.h > 0) {
            const s = cropSel;
            ctx.fillStyle = "rgba(0,0,0,0.55)";
            ctx.fillRect(0, 0, c.width, s.y * c.height); // top
            ctx.fillRect(
                0,
                (s.y + s.h) * c.height,
                c.width,
                (1 - (s.y + s.h)) * c.height,
            ); // bottom
            ctx.fillRect(0, s.y * c.height, s.x * c.width, s.h * c.height); // left
            ctx.fillRect(
                (s.x + s.w) * c.width,
                s.y * c.height,
                (1 - (s.x + s.w)) * c.width,
                s.h * c.height,
            ); // right
            ctx.strokeStyle = "#fff";
            ctx.lineWidth = 2;
            ctx.strokeRect(
                s.x * c.width,
                s.y * c.height,
                s.w * c.width,
                s.h * c.height,
            );
        }
    }, [rects, drawing, cropSel, mode]);

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

    const onPointerUp = () => {
        if (mode === "redact") {
            const d = drawing;
            setDrawing(null);
            // Ignore taps / hairline drags so a stray tap doesn't drop a dot.
            if (d && d.w > 0.012 && d.h > 0.012) {
                setRects((prev) => [...prev, d]);
            }
        }
        startRef.current = null;
    };

    const cropValid = !!cropSel && cropSel.w > 0.02 && cropSel.h > 0.02;

    /** Trim to the selected region, baking current redactions into it. */
    const applyCrop = () => {
        const img = imgRef.current;
        if (!img || !cropSel || !cropValid) return;
        const { w, h } = naturalRef.current;
        const sx = Math.round(cropSel.x * w);
        const sy = Math.round(cropSel.y * h);
        const sw = Math.max(1, Math.round(cropSel.w * w));
        const sh = Math.max(1, Math.round(cropSel.h * h));
        const off = document.createElement("canvas");
        off.width = sw;
        off.height = sh;
        const ctx = off.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, sx, sy, sw, sh, 0, 0, sw, sh);
        // Remap existing redaction boxes into the cropped coordinate space.
        ctx.fillStyle = "#000";
        for (const r of rects) {
            ctx.fillRect(
                ((r.x - cropSel.x) / cropSel.w) * sw,
                ((r.y - cropSel.y) / cropSel.h) * sh,
                (r.w / cropSel.w) * sw,
                (r.h / cropSel.h) * sh,
            );
        }
        setEdited(true);
        setMode("redact");
        loadSource(off.toDataURL("image/jpeg", 0.95));
    };

    const resetAll = () => {
        setEdited(false);
        setMode("redact");
        const url = URL.createObjectURL(file);
        loadSource(url, () => URL.revokeObjectURL(url));
    };

    const handleConfirm = () => {
        const img = imgRef.current;
        if (!img || busy) return;
        setBusy(true);
        try {
            const { w, h } = naturalRef.current;
            const off = document.createElement("canvas");
            off.width = w;
            off.height = h;
            const ctx = off.getContext("2d");
            if (!ctx) {
                onCancel();
                return;
            }
            ctx.drawImage(img, 0, 0, w, h);
            ctx.fillStyle = "#000";
            for (const r of rects) {
                ctx.fillRect(r.x * w, r.y * h, r.w * w, r.h * h);
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

    const dirty = edited || rects.length > 0;

    return (
        <Dialog
            open
            onOpenChange={(o) => {
                if (!o) onCancel();
            }}
        >
            <DialogContent
                className={cn(
                    "!bg-[hsl(var(--sidebar-background))] !text-[hsl(var(--sidebar-foreground))]",
                    "flex flex-col gap-3 sm:max-w-lg max-h-[92vh]",
                )}
            >
                <DialogTitle className="font-poppins font-bold">
                    Review, crop &amp; censor
                </DialogTitle>
                <DialogDescription className="text-xs leading-snug">
                    {mode === "redact"
                        ? "Drag across the photo to black out anything identifying — street and place names, shop signs, logos, license plates."
                        : "Drag to select the area to keep, then Apply crop to trim away the rest."}{" "}
                    Edits are burned into the image before it&apos;s sent.
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
                            : rects.length === 0
                              ? "No redactions yet (optional)."
                              : `${rects.length} area${rects.length > 1 ? "s" : ""} blacked out.`}
                    </span>
                    <div className="flex gap-2">
                        {mode === "crop" ? (
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
                        ) : (
                            <>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="gap-1.5"
                                    disabled={rects.length === 0 || busy}
                                    onClick={() =>
                                        setRects((r) => r.slice(0, -1))
                                    }
                                >
                                    <Undo2 className="w-3.5 h-3.5" />
                                    Undo
                                </Button>
                                <Button
                                    type="button"
                                    variant="outline"
                                    size="sm"
                                    className="gap-1.5"
                                    disabled={rects.length === 0 || busy}
                                    onClick={() => setRects([])}
                                >
                                    <Eraser className="w-3.5 h-3.5" />
                                    Clear
                                </Button>
                            </>
                        )}
                        <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            className="gap-1.5"
                            disabled={!dirty || busy}
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
