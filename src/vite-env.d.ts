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

/** Vite's `?raw` query returns the file contents as a string. Lets
 *  us import bundled markdown (e.g. the rulebook) without a runtime
 *  fetch. */
declare module "*?raw" {
    const content: string;
    export default content;
}

/** v1006: `@mapbox/vector-tile` + `pbf` (the headless MVT decoder,
 *  `basemapTiles.ts`) ship no TypeScript declarations, and the DefinitelyTyped
 *  `@types/*` packages don't resolve cleanly under strict pnpm — so tsc failed
 *  the CI build with TS7016. Declare them as ambient `any` modules; the
 *  decoder's runtime is validated on-device. */
declare module "@mapbox/vector-tile";
declare module "pbf";
