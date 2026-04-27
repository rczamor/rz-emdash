/**
 * Design System — runtime entrypoint.
 *
 * Routes:
 *   POST  design.parse                body: { source } — parse + validate, cache
 *   GET   design.get                  return cached parsed DESIGN.md
 *   GET   design.tokens               resolved tokens
 *   GET   design.validate             current validation report
 *   GET   design.systemPrompt         markdown block for prompt injection
 *   GET   design.exportTailwind       tailwind.config fragment
 *   POST  admin                       Block Kit
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import {
	assembleDesignSystemBlock,
	exportTailwindConfig,
	parseDesignSystem,
	resolveTokens,
	validateDesignSystem,
} from "./parse.js";
import type { ParsedDesignSystem, ValidationReport } from "./types.js";
import { DesignWatcher } from "./watcher.js";

const PARSED_KV = "cache:parsed";
const REPORT_KV = "cache:report";
const SOURCE_KV = "cache:source";
const WATCH_PATH_KV = "cache:watch_path";
const WATCHER_STATE = Symbol.for("emdash.pluginDesignSystem.watcher");

interface WatcherState {
	watcher: DesignWatcher | null;
}

type WatcherGlobal = typeof globalThis & {
	[WATCHER_STATE]?: WatcherState;
};

function getWatcherState(): WatcherState {
	const global = globalThis as WatcherGlobal;
	global[WATCHER_STATE] ??= { watcher: null };
	return global[WATCHER_STATE];
}

function startWatcher(ctx: PluginContext): void {
	const state = getWatcherState();
	if (state.watcher) return;
	state.watcher = new DesignWatcher({
		onChange: async (source, path) => {
			try {
				const parsed = parseDesignSystem(source);
				const report = validateDesignSystem(parsed);
				await ctx.kv.set(PARSED_KV, parsed);
				await ctx.kv.set(REPORT_KV, report);
				await ctx.kv.set(SOURCE_KV, source);
				await ctx.kv.set(WATCH_PATH_KV, path);
				const errors = report.findings.filter((f) => f.level === "error").length;
				const warnings = report.findings.filter((f) => f.level === "warning").length;
				ctx.log.info("Design system: parsed from filesystem", {
					path,
					errors,
					warnings,
				});
			} catch (err) {
				ctx.log.error("Design system: parse on watch failed", {
					path,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		},
		onError: (err) => {
			ctx.log.warn("Design system: watcher error", { error: err.message });
		},
	});
	state.watcher.start();
}

interface RouteCtx {
	input: unknown;
	request: Request;
}

async function getParsed(ctx: PluginContext): Promise<ParsedDesignSystem | null> {
	return (await ctx.kv.get<ParsedDesignSystem>(PARSED_KV)) ?? null;
}

async function getReport(ctx: PluginContext): Promise<ValidationReport | null> {
	return (await ctx.kv.get<ValidationReport>(REPORT_KV)) ?? null;
}

async function buildAdminPage(ctx: PluginContext) {
	const parsed = await getParsed(ctx);
	const report = await getReport(ctx);

	const blocks: unknown[] = [
		{ type: "header", text: "Design system" },
		{
			type: "context",
			elements: [
				{
					type: "text",
					text: "Implements Google Labs DESIGN.md spec. POST your DESIGN.md content to /design.parse to refresh.",
				},
			],
		},
	];

	if (!parsed) {
		blocks.push({
			type: "banner",
			variant: "default",
			title: "No design system loaded yet",
			description: "POST raw DESIGN.md text to /_emdash/api/plugins/design-system/design.parse",
		});
		return { blocks };
	}

	blocks.push({
		type: "fields",
		fields: [
			{ label: "Name", value: parsed.frontmatter.name ?? "—" },
			{ label: "Version", value: parsed.frontmatter.version ?? "—" },
			{ label: "Parsed at", value: parsed.parsedAt },
			{
				label: "Sections",
				value: String(parsed.sections.filter((s) => s.level === 2).length),
			},
		],
	});

	const tokenCount = Object.keys(parsed.frontmatter.colors ?? {}).length;
	const typoCount = Object.keys(parsed.frontmatter.typography ?? {}).length;
	const spacingCount = Object.keys(parsed.frontmatter.spacing ?? {}).length;
	const componentCount = Object.keys(parsed.frontmatter.components ?? {}).length;

	blocks.push({
		type: "stats",
		stats: [
			{ label: "Colors", value: String(tokenCount) },
			{ label: "Typography", value: String(typoCount) },
			{ label: "Spacing", value: String(spacingCount) },
			{ label: "Components", value: String(componentCount) },
		],
	});

	if (report && report.findings.length > 0) {
		blocks.push({ type: "header", text: "Validation" });
		const errors = report.findings.filter((f) => f.level === "error").length;
		const warnings = report.findings.filter((f) => f.level === "warning").length;
		const infos = report.findings.filter((f) => f.level === "info").length;
		blocks.push({
			type: "stats",
			stats: [
				{ label: "Errors", value: String(errors) },
				{ label: "Warnings", value: String(warnings) },
				{ label: "Info", value: String(infos) },
			],
		});
		blocks.push({
			type: "table",
			blockId: "design-findings",
			columns: [
				{ key: "level", label: "Level", format: "badge" },
				{ key: "code", label: "Code", format: "text" },
				{ key: "message", label: "Message", format: "text" },
				{ key: "location", label: "Location", format: "text" },
			],
			rows: report.findings.map((f) => ({
				level: f.level,
				code: f.code,
				message: f.message,
				location: f.location ?? "",
			})),
		});
	} else if (report) {
		blocks.push({
			type: "banner",
			variant: "default",
			title: "✅ Spec-clean",
			description:
				"No validation findings. Token refs all resolve, no duplicate sections, contrast within WCAG AA.",
		});
	}

	return { blocks };
}

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				ctx.log.info("Design system plugin installed");
				startWatcher(ctx);
			},
		},
		"plugin:activate": {
			handler: async (_event: unknown, ctx: PluginContext) => {
				startWatcher(ctx);
			},
		},
	},

	routes: {
		"design.parse": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { source?: string } | null;
				if (!body || typeof body.source !== "string") {
					return { ok: false, error: "source required (raw DESIGN.md text)" };
				}
				const parsed = parseDesignSystem(body.source);
				const report = validateDesignSystem(parsed);
				await ctx.kv.set(PARSED_KV, parsed);
				await ctx.kv.set(REPORT_KV, report);
				await ctx.kv.set(SOURCE_KV, body.source);
				return { ok: true, report };
			},
		},

		"design.reload": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const state = getWatcherState();
				if (!state.watcher) startWatcher(ctx);
				if (!state.watcher) return { ok: false, error: "Watcher unavailable (no fs access)" };
				return await state.watcher.reload();
			},
		},

		"design.watch.status": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const path = await ctx.kv.get<string>(WATCH_PATH_KV);
				const candidates = getWatcherState().watcher?.candidatePaths() ?? [];
				return {
					ok: true,
					watching: Boolean(path),
					path: path ?? null,
					candidates,
				};
			},
		},

		"design.get": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const parsed = await getParsed(ctx);
				if (!parsed) return { ok: false, error: "No design system loaded" };
				return { ok: true, design: parsed };
			},
		},

		"design.tokens": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const parsed = await getParsed(ctx);
				if (!parsed) return { ok: false, error: "No design system loaded" };
				const { resolved, unresolved } = resolveTokens(parsed.frontmatter);
				return { ok: true, tokens: resolved, unresolved };
			},
		},

		"design.validate": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const report = await getReport(ctx);
				if (!report) return { ok: false, error: "No design system loaded" };
				return { ok: true, report };
			},
		},

		"design.systemPrompt": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const parsed = await getParsed(ctx);
				if (!parsed) return { ok: false, markdown: "" };
				return { ok: true, markdown: assembleDesignSystemBlock(parsed) };
			},
		},

		"design.exportTailwind": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const parsed = await getParsed(ctx);
				if (!parsed) return { ok: false, error: "No design system loaded" };
				const config = exportTailwindConfig(parsed.frontmatter);
				return { ok: true, config };
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as { type?: string; page?: string };
				if (interaction.type === "page_load" && interaction.page === "/design") {
					return await buildAdminPage(ctx);
				}
				return { blocks: [] };
			},
		},
	},
});
