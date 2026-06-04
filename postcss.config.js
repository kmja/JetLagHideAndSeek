// Vite needs an explicit PostCSS config to pick up Tailwind +
// autoprefixer. Astro's tailwind integration handled this
// automatically; with plain Vite we wire it up by hand.
export default {
    plugins: {
        tailwindcss: {},
        autoprefixer: {},
    },
};
