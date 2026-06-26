/**
 * Shared photo-answer pipeline — compression + upload — used by both the
 * seeker-style photo card (`components/cards/photo.tsx`) and the hider's
 * in-dialog photo answer (`components/HiderView.tsx`). Kept in one place
 * so the two answer surfaces can never drift on resolution, quality, or
 * the upload/fallback behaviour.
 */
import { uploadGamePhoto } from "@/lib/multiplayer/store";

/**
 * Decode an image file and downscale it onto a canvas at the given max
 * edge. Phone photos are routinely 4–8 MB; we resize before encoding so
 * neither localStorage nor the upload carries the raw original.
 */
async function fileToScaledCanvas(
    file: Blob,
    maxEdge: number,
): Promise<HTMLCanvasElement> {
    return new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onerror = () => reject(reader.error);
        reader.onload = () => {
            const img = new Image();
            img.onerror = () => reject(new Error("decode failed"));
            img.onload = () => {
                const scale = Math.min(
                    1,
                    maxEdge / Math.max(img.width, img.height),
                );
                const w = Math.round(img.width * scale);
                const h = Math.round(img.height * scale);
                const canvas = document.createElement("canvas");
                canvas.width = w;
                canvas.height = h;
                const ctx = canvas.getContext("2d");
                if (!ctx) return reject(new Error("no 2d ctx"));
                ctx.drawImage(img, 0, 0, w, h);
                resolve(canvas);
            };
            img.src = reader.result as string;
        };
        reader.readAsDataURL(file);
    });
}

/** Compress to a JPEG data URI at the given max edge. */
export async function fileToCompressedDataUri(
    file: Blob,
    maxEdge = 1200,
    quality = 0.8,
): Promise<string> {
    const canvas = await fileToScaledCanvas(file, maxEdge);
    return canvas.toDataURL("image/jpeg", quality);
}

/** Compress to a JPEG Blob at the given max edge (the R2 upload payload). */
export async function fileToCompressedBlob(
    file: Blob,
    maxEdge = 2560,
    quality = 0.85,
): Promise<Blob> {
    const canvas = await fileToScaledCanvas(file, maxEdge);
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error("encode failed"))),
            "image/jpeg",
            quality,
        );
    });
}

/** What the caller should store locally and/or send to the seekers. */
export interface PreparedPhoto {
    /** Small thumbnail (online) or full-res image (offline) data URI. */
    photoUri: string;
    /** Full-detail image URL in R2 — present only on a successful upload. */
    photoUrl?: string;
    /** True when an online upload failed and we fell back to a thumbnail. */
    fellBack: boolean;
}

/**
 * Prepare a picked/edited photo for an answer.
 *
 *  - **Online**: upload a full-detail (~2560px) JPEG to R2 and keep a small
 *    local thumbnail. The seekers view the full image via `photoUrl`; only
 *    that short URL needs to cross the WebSocket. If the upload fails, fall
 *    back to a thumbnail (`fellBack: true`) so the seekers still get
 *    *something* under the 64 KB message cap.
 *  - **Offline / solo**: inline the full-resolution image in `photoUri`
 *    (no seeker to send it to).
 */
export async function preparePhotoForSend(
    file: Blob,
    online: boolean,
): Promise<PreparedPhoto> {
    if (!online) {
        return {
            photoUri: await fileToCompressedDataUri(file, 2560, 0.85),
            fellBack: false,
        };
    }
    const thumb = await fileToCompressedDataUri(file, 640, 0.7);
    try {
        const fullBlob = await fileToCompressedBlob(file, 2560, 0.85);
        const photoUrl = await uploadGamePhoto(fullBlob);
        return { photoUri: thumb, photoUrl, fellBack: false };
    } catch (e) {
        console.warn("photo upload failed; using inline thumbnail", e);
        return { photoUri: thumb, fellBack: true };
    }
}
