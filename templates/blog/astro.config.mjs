import node from "@astrojs/node";
import react from "@astrojs/react";
import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";
import { resendPlugin } from "@emdash-cms/plugin-resend";
import { defineConfig, fontProviders } from "astro/config";
import emdash, { local } from "emdash/astro";
import { postgres } from "emdash/db";

export default defineConfig({
	output: "server",
	adapter: node({
		mode: "standalone",
	}),
	image: {
		layout: "constrained",
		responsiveStyles: true,
	},
	integrations: [
		react(),
		emdash({
			// Empty config — pg.Pool reads PGHOST / PGUSER / PGPASSWORD / PGDATABASE
			// / PGPORT from the runtime environment. Setting them at config time
			// would bake values into the build at `astro build` time.
			database: postgres({}),
			storage: local({
				directory: "./uploads",
				baseUrl: "/_emdash/api/media/file",
			}),
			plugins: [
				auditLogPlugin(),
				resendPlugin({
					apiKey: process.env.RESEND_API_KEY,
					from: process.env.RESEND_FROM ?? "onboarding@resend.dev",
					replyTo: process.env.RESEND_REPLY_TO,
				}),
			],
		}),
	],
	fonts: [
		{
			provider: fontProviders.google(),
			name: "Inter",
			cssVariable: "--font-sans",
			weights: [400, 500, 600, 700],
			fallbacks: ["sans-serif"],
		},
		{
			provider: fontProviders.google(),
			name: "JetBrains Mono",
			cssVariable: "--font-mono",
			weights: [400, 500],
			fallbacks: ["monospace"],
		},
	],
	devToolbar: { enabled: false },
});
