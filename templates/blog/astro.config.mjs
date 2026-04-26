import node from "@astrojs/node";
import react from "@astrojs/react";
import { addressPlugin } from "@emdash-cms/plugin-address";
import { agentsPlugin } from "@emdash-cms/plugin-agents";
import { auditLogPlugin } from "@emdash-cms/plugin-audit-log";
import { automationsPlugin } from "@emdash-cms/plugin-automations";
import { brandPlugin } from "@emdash-cms/plugin-brand";
import { designSystemPlugin } from "@emdash-cms/plugin-design-system";
import { langfusePlugin } from "@emdash-cms/plugin-langfuse";
import { llmRouterPlugin } from "@emdash-cms/plugin-llm-router";
import { pathautoPlugin } from "@emdash-cms/plugin-pathauto";
import { pgvectorPlugin } from "@emdash-cms/plugin-pgvector";
import { resendPlugin } from "@emdash-cms/plugin-resend";
import { schedulerPlugin } from "@emdash-cms/plugin-scheduler";
import { tasksPlugin } from "@emdash-cms/plugin-tasks";
import { tokensPlugin } from "@emdash-cms/plugin-tokens";
import { toolsPlugin } from "@emdash-cms/plugin-tools";
import { webformPlugin } from "@emdash-cms/plugin-webform";
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
				tokensPlugin(),
				webformPlugin(),
				pathautoPlugin(),
				addressPlugin(),
				automationsPlugin(),
				tasksPlugin(),
				agentsPlugin(),
				toolsPlugin(),
				brandPlugin(),
				designSystemPlugin(),
				pgvectorPlugin(),
				schedulerPlugin(),
				llmRouterPlugin(),
				langfusePlugin(),
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
