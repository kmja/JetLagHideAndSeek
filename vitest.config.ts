import { defineConfig } from "vitest/config";

export default defineConfig({
    test: {
        alias: {
            "@/": new URL("./src/", import.meta.url).pathname,
            "@protocol": new URL("./protocol", import.meta.url).pathname,
        },
    },
});
