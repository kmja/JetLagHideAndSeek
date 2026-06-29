/** @type {import('tailwindcss').Config} */
export default {
    darkMode: ["class"],
    content: ["./src/**/*.{astro,html,js,jsx,md,mdx,svelte,ts,tsx,vue}"],
    theme: {
    	extend: {
    		colors: {
    			jetlag: '#1F2F3F',
    			background: 'hsl(var(--background))',
    			foreground: 'hsl(var(--foreground))',
    			card: {
    				DEFAULT: 'hsl(var(--card))',
    				foreground: 'hsl(var(--card-foreground))'
    			},
    			popover: {
    				DEFAULT: 'hsl(var(--popover))',
    				foreground: 'hsl(var(--popover-foreground))'
    			},
    			primary: {
    				DEFAULT: 'hsl(var(--primary))',
    				foreground: 'hsl(var(--primary-foreground))'
    			},
    			secondary: {
    				DEFAULT: 'hsl(var(--secondary))',
    				foreground: 'hsl(var(--secondary-foreground))'
    			},
    			muted: {
    				DEFAULT: 'hsl(var(--muted))',
    				foreground: 'hsl(var(--muted-foreground))'
    			},
    			accent: {
    				DEFAULT: 'hsl(var(--accent))',
    				foreground: 'hsl(var(--accent-foreground))'
    			},
    			destructive: {
    				DEFAULT: 'hsl(var(--destructive))',
    				foreground: 'hsl(var(--destructive-foreground))'
    			},
    			success: {
    				DEFAULT: 'hsl(var(--success))',
    				foreground: 'hsl(var(--success-foreground))'
    			},
    			warning: {
    				DEFAULT: 'hsl(var(--warning))',
    				foreground: 'hsl(var(--warning-foreground))'
    			},
    			info: {
    				DEFAULT: 'hsl(var(--info))',
    				foreground: 'hsl(var(--info-foreground))'
    			},
    			// Supporting brand accents (box / dice / card-stripe palette).
    			// Promoted from raw `hsl(var(--accent-*))` arbitrary values so
    			// `bg-accent-yellow` / `text-accent-purple` / `…/15` all work.
    			'accent-yellow': 'hsl(var(--accent-yellow))',
    			'accent-orange': 'hsl(var(--accent-orange))',
    			'accent-red': 'hsl(var(--accent-red))',
    			'accent-peach': 'hsl(var(--accent-peach))',
    			'accent-purple': 'hsl(var(--accent-purple))',
    			border: 'hsl(var(--border))',
    			input: 'hsl(var(--input))',
    			ring: 'hsl(var(--ring))',
    			chart: {
    				'1': 'hsl(var(--chart-1))',
    				'2': 'hsl(var(--chart-2))',
    				'3': 'hsl(var(--chart-3))',
    				'4': 'hsl(var(--chart-4))',
    				'5': 'hsl(var(--chart-5))'
    			},
    			sidebar: {
    				DEFAULT: 'hsl(var(--sidebar-background))',
    				foreground: 'hsl(var(--sidebar-foreground))',
    				primary: 'hsl(var(--sidebar-primary))',
    				'primary-foreground': 'hsl(var(--sidebar-primary-foreground))',
    				accent: 'hsl(var(--sidebar-accent))',
    				'accent-foreground': 'hsl(var(--sidebar-accent-foreground))',
    				border: 'hsl(var(--sidebar-border))',
    				ring: 'hsl(var(--sidebar-ring))'
    			}
    		},
    		fontFamily: {
    			// Display — M PLUS Rounded 1c. Used for the HIDE+SEEK
    			// wordmark and any header that wants to echo the rulebook
    			// cover (rounded geometric, heavy weight).
    			display: ["'M PLUS Rounded 1c'", "system-ui", "sans-serif"],
    			// Headings — Inter Tight (condensed, sharp terminals). We
    			// keep the legacy `font-poppins` class name as an alias so
    			// existing call-sites don't all need rewriting in one batch.
    			poppins: ["'Inter Tight'", "system-ui", "sans-serif"],
    			"inter-tight": ["'Inter Tight'", "system-ui", "sans-serif"],
    			// Body — Inter. Same alias trick for the old `font-oxygen`.
    			oxygen: ["'Inter'", "system-ui", "sans-serif"],
    			inter: ["'Inter'", "system-ui", "sans-serif"],
    		},
    		borderRadius: {
    			lg: 'var(--radius)',
    			md: 'calc(var(--radius) - 2px)',
    			sm: 'calc(var(--radius) - 4px)'
    		}
    	},
    },
    plugins: [require("tailwindcss-animate")],
};
