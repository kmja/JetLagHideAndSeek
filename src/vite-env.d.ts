/// <reference types="vite/client" />
/// <reference types="vite-plugin-pwa/client" />

// Augment ImportMeta with vite's env shape. Stops the
// pre-existing `Property 'env' does not exist on type
// 'ImportMeta'` error in `src/maps/api/overpass.ts` and
// anywhere else that reads `import.meta.env`.
interface ImportMetaEnv {
    readonly BASE_URL: string;
    readonly DEV: boolean;
    readonly PROD: boolean;
    readonly MODE: string;
    readonly SSR: boolean;
}

interface ImportMeta {
    readonly env: ImportMetaEnv;
}
