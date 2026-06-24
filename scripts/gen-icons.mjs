// Rasterise public/favicon.svg into the PNG icon set (favicon, apple-touch,
// android-chrome, og image). Run after editing the mark:
//
//   npm i sharp --no-save && node scripts/gen-icons.mjs
//
// sharp is intentionally NOT a saved dependency — this is a one-off
// design step, not part of the app/Cloudflare build. The generated PNGs
// are committed; sharp is not.
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import sharp from "sharp";

const pub = join(dirname(fileURLToPath(import.meta.url)), "..", "public");
const svg = readFileSync(join(pub, "favicon.svg"));

const targets = [
    ["favicon-16x16.png", 16],
    ["favicon-32x32.png", 32],
    ["apple-touch-icon.png", 180],
    ["android-chrome-192x192.png", 192],
    ["android-chrome-512x512.png", 512],
    ["JLIcon.png", 512],
];

for (const [name, size] of targets) {
    // High render density so the 64-unit SVG rasterises crisp at every
    // size, then downscale to the exact target.
    await sharp(svg, { density: 600 })
        .resize(size, size)
        .png()
        .toFile(join(pub, name));
    console.log(`wrote ${name} (${size}px)`);
}
