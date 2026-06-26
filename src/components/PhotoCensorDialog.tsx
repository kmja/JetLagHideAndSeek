import { Check, Eraser, Undo2, X } from "lucide-react";
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

/** A redaction rectangle in normalized [0..1] image coordinates. */
interface NormRect {
    x: number;
    y: number;
    w: number;
    h: number;
}

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
 * Review-and-censor step shown after the hider picks a photo, before it's
 * compressed/uploaded. The hider drags to paint opaque black boxes over
 * anything identifying — street names, shop signs, logos, license plates.
 *
 * Crucially the redaction is **destructive**: on confirm we draw the image
 * plus the boxes onto a full-resolution canvas and re-encode to a JPEG, so
 * the covered pixels are gone from the file that gets sent. It is not an
 * overlay the seeker could peel back.
 *
 * Adding boxes is optional — confirming with none just sends the photo as
 * a normal review/confirm gesture.
 */
export function PhotoCensorDialog({
    file,
    onConfirm,
    onCancel,
}: {
    file: File;
    onConfirm: (redacted: File) => void;
    onCancel: () => void;
}) {
    const canvasRef = useRef<HTMLCanvasElement>(null);
    const imgRef = useRef<HTMLImageElement | null>(null);
    const naturalRef = useRef<{ w: number; h: number }>({ w: 0, h: 0 });
    const startRef = useRef<{ x: number; y: number } | null>(null);

    const [ready, setReady] = useState(false);
    const [rects, setRects] = useState<NormRect[]>([]);
    const [drawing, setDrawing] = useState<NormRect | null>(null);
    const [busy, setBusy] = useState(false);

    // Repaint the preview canvas: base image, committed boxes, then the
    // in-progress box on top.
    const draw = useCallback(() => {
        const c = canvasRef.current;
        const img = imgRef.current;
        if (!c || !img) return;
        const ctx = c.getContext("2d");
        if (!ctx) return;
        ctx.drawImage(img, 0, 0, c.width, c.height);
        ctx.fillStyle = "#000";
        const all = drawing ? [...rects, drawing] : rects;
        for (const r of all) {
            ctx.fillRect(r.x * c.width, r.y * c.height, r.w * c.width, r.h * c.height);
        }
    }, [rects, drawing]);

    // Decode the picked file once and size the preview canvas to fit.
    useEffect(() => {
        const url = URL.createObjectURL(file);
        const img = new Image();
        img.onload = () => {
            imgRef.current = img;
            naturalRef.current = { w: img.naturalWidth, h: img.naturalHeight };
            const c = canvasRef.current;
            if (c) {
                const maxW = 720;
                const scale = Math.min(1, maxW / img.naturalWidth || 1);
                c.width = Math.max(1, Math.round(img.naturalWidth * scale));
                c.height = Math.max(1, Math.round(img.naturalHeight * scale));
            }
            setReady(true);
        };
        img.onerror = () => {
            URL.revokeObjectURL(url);
            onCancel();
        };
        img.src = url;
        return () => URL.revokeObjectURL(url);
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [file]);

    useEffect(() => {
        draw();
    }, [draw, ready]);

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
        setDrawing({ x: p.x, y: p.y, w: 0, h: 0 });
    };

    const onPointerMove = (e: React.PointerEvent) => {
        if (!startRef.current) return;
        setDrawing(rectFromPoints(startRef.current, toNorm(e)));
    };

    const onPointerUp = () => {
        const d = drawing;
        startRef.current = null;
        setDrawing(null);
        // Ignore taps / hairline drags so a stray tap doesn't drop a dot.
        if (d && d.w > 0.012 && d.h > 0.012) {
            setRects((prev) => [...prev, d]);
        }
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
                // High quality here — the upload pipeline does the real
                // downscale/compression. We just need the redaction baked in.
                0.95,
            );
        } catch {
            setBusy(false);
            onCancel();
        }
    };

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
                    Review &amp; censor photo
                </DialogTitle>
                <DialogDescription className="text-xs leading-snug">
                    Drag across the photo to black out anything that could
                    identify your area — street and place names, shop signs,
                    logos, license plates. Redactions are burned into the
                    image before it&apos;s sent; they can&apos;t be undone by
                    the seekers.
                </DialogDescription>

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

                <div className="flex items-center justify-between gap-2">
                    <span className="text-[11px] text-muted-foreground">
                        {rects.length === 0
                            ? "No redactions yet (optional)."
                            : `${rects.length} area${rects.length > 1 ? "s" : ""} blacked out.`}
                    </span>
                    <div className="flex gap-2">
                        <Button
                            type="button"
                            variant="outline"
                            size="sm"
                            className="gap-1.5"
                            disabled={rects.length === 0 || busy}
                            onClick={() => setRects((r) => r.slice(0, -1))}
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
