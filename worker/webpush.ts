/**
 * Web Push (RFC 8291 + RFC 8188) implementation for Cloudflare Workers.
 *
 * Uses only the Web Crypto API so no Node.js compat is required and the
 * bundle adds zero third-party dependencies.
 */

export interface PushSubscriptionData {
    endpoint: string;
    expirationTime: number | null;
    keys: {
        p256dh: string;
        auth: string;
    };
}

export interface VapidKeys {
    d: string; // base64url raw private scalar
    x: string; // base64url x coordinate of public key
    y: string; // base64url y coordinate of public key
}

export function parseVapidKeys(jsonStr: string): VapidKeys | null {
    try {
        const k = JSON.parse(jsonStr) as VapidKeys;
        if (typeof k.d !== "string" || typeof k.x !== "string" || typeof k.y !== "string") {
            return null;
        }
        return k;
    } catch {
        return null;
    }
}

/* ────────────────── Byte helpers ────────────────── */

function b64urlToBytes(b64: string): Uint8Array {
    const padded = b64.replace(/-/g, "+").replace(/_/g, "/");
    const bin = atob(padded);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return bytes;
}

function bytesToB64url(bytes: Uint8Array): string {
    let bin = "";
    for (const b of bytes) bin += String.fromCharCode(b);
    return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=/g, "");
}

function concat(...arrays: Uint8Array[]): Uint8Array {
    const total = arrays.reduce((s, a) => s + a.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const a of arrays) { out.set(a, off); off += a.length; }
    return out;
}

const enc = new TextEncoder();

// Ensure a fresh ArrayBuffer-backed Uint8Array (strict TS requires this for
// Web Crypto API calls, which take BufferSource = ArrayBufferView<ArrayBuffer>).
function bytes(src: Uint8Array | number): Uint8Array<ArrayBuffer> {
    if (typeof src === "number") return new Uint8Array(src) as Uint8Array<ArrayBuffer>;
    const out = new Uint8Array(src.length) as Uint8Array<ArrayBuffer>;
    out.set(src);
    return out;
}

/* ────────────────── HKDF helpers (manual, two-step) ────────────────── */

async function hmacSha256(key: Uint8Array, data: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    const k = await crypto.subtle.importKey(
        "raw", bytes(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"],
    );
    return new Uint8Array(await crypto.subtle.sign("HMAC", k, bytes(data))) as Uint8Array<ArrayBuffer>;
}

async function hkdfExtract(salt: Uint8Array, ikm: Uint8Array): Promise<Uint8Array<ArrayBuffer>> {
    return hmacSha256(salt, ikm);
}

async function hkdfExpand(prk: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array<ArrayBuffer>> {
    const result = bytes(length);
    let t: Uint8Array<ArrayBuffer> = bytes(0);
    let offset = 0;
    for (let i = 1; offset < length; i++) {
        t = await hmacSha256(prk, concat(t, info, bytes(new Uint8Array([i]))));
        const n = Math.min(length - offset, t.length);
        result.set(t.subarray(0, n), offset);
        offset += n;
    }
    return result;
}

/* ────────────────── Content encryption (RFC 8291 / RFC 8188) ────────────────── */

async function encryptPayload(
    subscription: PushSubscriptionData,
    plaintext: Uint8Array,
): Promise<Uint8Array> {
    const clientPub = b64urlToBytes(subscription.keys.p256dh);
    const authSecret = b64urlToBytes(subscription.keys.auth);
    const salt = crypto.getRandomValues(new Uint8Array(16));

    const serverKP = await crypto.subtle.generateKey(
        { name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"],
    );
    const serverPubRaw = new Uint8Array(
        await crypto.subtle.exportKey("raw", serverKP.publicKey),
    );

    const clientKey = await crypto.subtle.importKey(
        "raw", bytes(clientPub), { name: "ECDH", namedCurve: "P-256" }, false, [],
    );

    const ecdhBits = await crypto.subtle.deriveBits(
        { name: "ECDH", public: clientKey },
        serverKP.privateKey,
        256,
    );
    const ecdhSecret = new Uint8Array(ecdhBits);

    const prkKey = await hkdfExtract(authSecret, ecdhSecret);
    const keyInfo = concat(enc.encode("WebPush: info\x00"), clientPub, serverPubRaw);
    const ikm = await hkdfExpand(prkKey, keyInfo, 32);

    const prk = await hkdfExtract(salt, ikm);
    const cek = await hkdfExpand(prk, enc.encode("Content-Encoding: aes128gcm\x00"), 16);
    const nonce = await hkdfExpand(prk, enc.encode("Content-Encoding: nonce\x00"), 12);

    const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
    const ciphertext = new Uint8Array(
        await crypto.subtle.encrypt(
            { name: "AES-GCM", iv: nonce, tagLength: 128 },
            aesKey,
            bytes(concat(plaintext, new Uint8Array([2]))),
        ),
    );

    const rs = 4096;
    const rsBytes = new Uint8Array(4);
    new DataView(rsBytes.buffer).setUint32(0, rs, false);

    return concat(salt, rsBytes, new Uint8Array([serverPubRaw.length]), serverPubRaw, ciphertext);
}

/* ────────────────── VAPID JWT ────────────────── */

async function createVapidJwt(
    keys: VapidKeys,
    audience: string,
    subject: string,
): Promise<string> {
    const header = { typ: "JWT", alg: "ES256" };
    const payload = {
        aud: audience,
        exp: Math.floor(Date.now() / 1000) + 43200,
        sub: subject,
    };

    const headerB64 = bytesToB64url(enc.encode(JSON.stringify(header)));
    const payloadB64 = bytesToB64url(enc.encode(JSON.stringify(payload)));
    const sigInput = `${headerB64}.${payloadB64}`;

    const privateKey = await crypto.subtle.importKey(
        "jwk",
        { kty: "EC", crv: "P-256", d: keys.d, x: keys.x, y: keys.y },
        { name: "ECDSA", namedCurve: "P-256" },
        false,
        ["sign"],
    );
    const signature = new Uint8Array(
        await crypto.subtle.sign(
            { name: "ECDSA", hash: "SHA-256" },
            privateKey,
            enc.encode(sigInput),
        ),
    );

    return `${sigInput}.${bytesToB64url(signature)}`;
}

/* ────────────────── Public entry point ────────────────── */

export type PushResult = "ok" | "gone" | "error";

export async function sendWebPush(
    subscription: PushSubscriptionData,
    payload: { title: string; body?: string; tag?: string },
    vapidKeys: VapidKeys,
    vapidPublicKey: string,
    subject: string,
): Promise<PushResult> {
    try {
        const body = bytes(await encryptPayload(subscription, enc.encode(JSON.stringify(payload))));
        const audience = new URL(subscription.endpoint).origin;
        const jwt = await createVapidJwt(vapidKeys, audience, subject);

        const resp = await fetch(subscription.endpoint, {
            method: "POST",
            headers: {
                "Content-Type": "application/octet-stream",
                "Content-Encoding": "aes128gcm",
                "Authorization": `vapid t=${jwt}, k=${vapidPublicKey}`,
                "TTL": "86400",
                "Urgency": "normal",
            },
            body,
        });

        if (resp.status === 410 || resp.status === 404) return "gone";
        if (!resp.ok && resp.status !== 201) {
            console.warn("[webpush] push failed:", resp.status);
            return "error";
        }
        return "ok";
    } catch (e) {
        console.warn("[webpush] sendWebPush threw", e);
        return "error";
    }
}
