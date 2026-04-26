/**
 * Automations — runtime entrypoint.
 *
 * Wires every relevant emdash hook to the engine, plus cron. Each hook
 * handler delegates to `dispatchEvent(<source>, <event>, ctx)`, which
 * looks up routines whose `triggerOn` index matches and runs them.
 *
 * Routines are CRUD'd via API routes. After any change a `reconcileCron()`
 * pass keeps the registered cron schedules in sync.
 */

import { definePlugin } from "emdash";
import type { PluginContext } from "emdash";

import { dispatchEvent, reconcileCron } from "./engine.js";
import type { Routine } from "./types.js";

interface RouteCtx {
	input: unknown;
	request: Request;
}

function getQueryParam(routeCtx: RouteCtx, key: string): string | undefined {
	return new URL(routeCtx.request.url).searchParams.get(key) ?? undefined;
}

function isValidId(id: unknown): id is string {
	return typeof id === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/.test(id);
}

/** Storage tag used as the `triggerOn` index for routine lookup. */
function triggerKey(routine: Routine): string {
	return routine.trigger.on;
}

/**
 * Persist a routine. Stamps the `triggerOn` index field at the top level so
 * the storage query in `findRoutinesFor` can be index-driven.
 */
async function saveRoutine(routine: Routine, ctx: PluginContext): Promise<void> {
	// Storage indexes only see top-level fields. We embed the trigger source
	// at the top of the storage record so the index sees it.
	const record = { ...routine, triggerOn: triggerKey(routine) } as unknown as Routine;
	await ctx.storage.routines.put(routine.id, record);
}

async function buildAdminPage(ctx: PluginContext) {
	const result = await ctx.storage.routines.query({
		orderBy: { createdAt: "desc" },
		limit: 200,
	});
	const routines = result.items.map((i) => i.data as Routine);

	const blocks: unknown[] = [
		{ type: "header", text: "Automations" },
		{
			type: "context",
			elements: [
				{
					type: "text",
					text: "Routines are authored by agents via the API (POST routines.upsert). Toggle them on/off here.",
				},
			],
		},
	];

	if (routines.length === 0) {
		blocks.push({
			type: "banner",
			variant: "default",
			title: "No routines yet",
			description: "Ask an agent to create one via /_emdash/api/plugins/automations/routines.upsert.",
		});
	} else {
		blocks.push({
			type: "table",
			blockId: "automations-list",
			columns: [
				{ key: "id", label: "ID", format: "text" },
				{ key: "name", label: "Name", format: "text" },
				{ key: "trigger", label: "Trigger", format: "text" },
				{ key: "actions", label: "Actions", format: "text" },
				{ key: "enabled", label: "Status", format: "badge" },
				{ key: "lastRunAt", label: "Last run", format: "relative_time" },
				{ key: "runCount", label: "Runs", format: "text" },
			],
			rows: routines.map((r) => ({
				id: r.id,
				name: r.name,
				trigger:
					r.trigger.on === "cron"
						? `cron(${(r.trigger as { schedule: string }).schedule})`
						: r.trigger.on,
				actions: r.actions.map((a) => a.type).join(","),
				enabled: r.enabled ? "Enabled" : "Disabled",
				lastRunAt: r.stats?.lastRunAt ?? "",
				runCount: String(r.stats?.runCount ?? 0),
			})),
		});

		// Per-row toggle + test buttons
		for (const r of routines) {
			blocks.push({
				type: "actions",
				elements: [
					{ type: "context", elements: [{ type: "text", text: r.id }] },
					{
						type: "button",
						text: r.enabled ? "Disable" : "Enable",
						action_id: "toggle_routine",
						value: r.id,
						style: r.enabled ? "secondary" : "primary",
					},
					{
						type: "button",
						text: "Test",
						action_id: "test_routine",
						value: r.id,
					},
				],
			});
		}
	}

	return { blocks };
}

async function buildRecentWidget(ctx: PluginContext) {
	const result = await ctx.storage.routines.query({
		orderBy: { createdAt: "desc" },
		limit: 5,
	});
	const recent = result.items
		.map((i) => i.data as Routine)
		.filter((r) => r.stats?.lastRunAt)
		.sort((a, b) => (b.stats!.lastRunAt ?? "").localeCompare(a.stats!.lastRunAt ?? ""))
		.slice(0, 5);
	return {
		blocks: [
			{ type: "header", text: "Recent automation runs" },
			{
				type: "table",
				blockId: "automations-recent",
				columns: [
					{ key: "name", label: "Routine", format: "text" },
					{ key: "lastRunAt", label: "When", format: "relative_time" },
					{ key: "lastError", label: "Error", format: "text" },
				],
				rows: recent.map((r) => ({
					name: r.name,
					lastRunAt: r.stats!.lastRunAt!,
					lastError: r.stats?.lastError ?? "",
				})),
			},
		],
	};
}

const NOW = () => new Date().toISOString();

export default definePlugin({
	hooks: {
		"plugin:install": {
			handler: async (_event, ctx: PluginContext) => {
				ctx.log.info("Automations plugin installed");
			},
		},
		"plugin:activate": {
			handler: async (_event, ctx: PluginContext) => {
				await reconcileCron(ctx);
			},
		},

		// Cron handler — fires for every scheduled routine.
		cron: {
			handler: async (event, ctx: PluginContext) => {
				const routine = (await ctx.storage.routines.get(event.name)) as Routine | null;
				if (!routine || !routine.enabled || routine.trigger.on !== "cron") return;
				await dispatchEvent("cron", { name: event.name, scheduledAt: event.scheduledAt }, ctx);
			},
		},

		// Content lifecycle hooks
		"content:beforeSave": {
			handler: async (event, ctx) => {
				await dispatchEvent("content:beforeSave", event as unknown as Record<string, unknown>, ctx);
			},
		},
		"content:afterSave": {
			handler: async (event, ctx) => {
				await dispatchEvent("content:afterSave", event as unknown as Record<string, unknown>, ctx);
			},
		},
		"content:beforeDelete": {
			handler: async (event, ctx) => {
				await dispatchEvent(
					"content:beforeDelete",
					event as unknown as Record<string, unknown>,
					ctx,
				);
			},
		},
		"content:afterDelete": {
			handler: async (event, ctx) => {
				await dispatchEvent("content:afterDelete", event as unknown as Record<string, unknown>, ctx);
			},
		},
		"content:afterPublish": {
			handler: async (event, ctx) => {
				await dispatchEvent(
					"content:afterPublish",
					event as unknown as Record<string, unknown>,
					ctx,
				);
			},
		},
		"content:afterUnpublish": {
			handler: async (event, ctx) => {
				await dispatchEvent(
					"content:afterUnpublish",
					event as unknown as Record<string, unknown>,
					ctx,
				);
			},
		},

		// Media hooks
		"media:beforeUpload": {
			handler: async (event, ctx) => {
				await dispatchEvent("media:beforeUpload", event as unknown as Record<string, unknown>, ctx);
			},
		},
		"media:afterUpload": {
			handler: async (event, ctx) => {
				await dispatchEvent("media:afterUpload", event as unknown as Record<string, unknown>, ctx);
			},
		},

		// Comment hooks
		"comment:beforeCreate": {
			handler: async (event, ctx) => {
				await dispatchEvent(
					"comment:beforeCreate",
					event as unknown as Record<string, unknown>,
					ctx,
				);
			},
		},
		"comment:afterCreate": {
			handler: async (event, ctx) => {
				await dispatchEvent(
					"comment:afterCreate",
					event as unknown as Record<string, unknown>,
					ctx,
				);
			},
		},
		"comment:afterModerate": {
			handler: async (event, ctx) => {
				await dispatchEvent(
					"comment:afterModerate",
					event as unknown as Record<string, unknown>,
					ctx,
				);
			},
		},

		"email:afterSend": {
			handler: async (event, ctx) => {
				await dispatchEvent("email:afterSend", event as unknown as Record<string, unknown>, ctx);
			},
		},
	},

	routes: {
		"routines.list": {
			handler: async (_routeCtx: RouteCtx, ctx: PluginContext) => {
				const result = await ctx.storage.routines.query({
					orderBy: { createdAt: "desc" },
					limit: 500,
				});
				return { routines: result.items.map((i) => i.data) };
			},
		},

		"routines.get": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const id = getQueryParam(routeCtx, "id");
				if (!isValidId(id)) return { ok: false, error: "Missing or invalid id" };
				const r = await ctx.storage.routines.get(id);
				if (!r) return { ok: false, error: "Not found" };
				return { ok: true, routine: r };
			},
		},

		"routines.upsert": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as Partial<Routine> | null;
				if (!body || !isValidId(body.id)) return { ok: false, error: "Invalid id" };
				if (!body.name) return { ok: false, error: "Name required" };
				if (!body.trigger || !body.trigger.on) return { ok: false, error: "Trigger required" };
				if (!Array.isArray(body.actions) || body.actions.length === 0) {
					return { ok: false, error: "At least one action required" };
				}
				if (body.trigger.on === "cron" && !(body.trigger as { schedule?: string }).schedule) {
					return { ok: false, error: "Cron trigger requires a schedule" };
				}

				const existing = (await ctx.storage.routines.get(body.id)) as Routine | null;
				const routine: Routine = {
					id: body.id,
					name: body.name,
					description: body.description,
					enabled: body.enabled ?? true,
					trigger: body.trigger,
					filter: body.filter,
					actions: body.actions,
					createdAt: existing?.createdAt ?? NOW(),
					updatedAt: NOW(),
					stats: existing?.stats,
				};
				await saveRoutine(routine, ctx);
				if (routine.trigger.on === "cron") await reconcileCron(ctx);
				return { ok: true, routine };
			},
		},

		"routines.delete": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: unknown } | null;
				if (!body || !isValidId(body.id)) return { ok: false, error: "Invalid id" };
				const existing = (await ctx.storage.routines.get(body.id)) as Routine | null;
				const removed = await ctx.storage.routines.delete(body.id);
				if (existing?.trigger.on === "cron" && ctx.cron) {
					try {
						await ctx.cron.cancel(body.id);
					} catch {
						/* best effort */
					}
				}
				return { ok: true, removed };
			},
		},

		"routines.test": {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const body = routeCtx.input as { id?: unknown; event?: Record<string, unknown> } | null;
				if (!body || !isValidId(body.id)) return { ok: false, error: "Invalid id" };
				const routine = (await ctx.storage.routines.get(body.id)) as Routine | null;
				if (!routine) return { ok: false, error: "Not found" };
				const { executeRoutine } = await import("./engine.js");
				const event = body.event ?? {};
				try {
					await executeRoutine(routine, event, ctx.site?.name ?? "Site", ctx);
					return { ok: true };
				} catch (err) {
					return { ok: false, error: err instanceof Error ? err.message : String(err) };
				}
			},
		},

		admin: {
			handler: async (routeCtx: RouteCtx, ctx: PluginContext) => {
				const interaction = routeCtx.input as {
					type?: string;
					page?: string;
					widget?: string;
					action_id?: string;
					value?: string;
				};

				if (interaction.type === "page_load" && interaction.page === "/automations") {
					return await buildAdminPage(ctx);
				}
				if (interaction.type === "widget_load" && interaction.widget === "automations-recent") {
					return await buildRecentWidget(ctx);
				}

				// Toggle enable/disable
				if (
					interaction.type === "block_action" &&
					interaction.action_id === "toggle_routine" &&
					isValidId(interaction.value)
				) {
					const r = (await ctx.storage.routines.get(interaction.value)) as Routine | null;
					if (!r) {
						return {
							...(await buildAdminPage(ctx)),
							toast: { message: "Routine not found", type: "error" },
						};
					}
					r.enabled = !r.enabled;
					r.updatedAt = NOW();
					await saveRoutine(r, ctx);
					if (r.trigger.on === "cron") await reconcileCron(ctx);
					return {
						...(await buildAdminPage(ctx)),
						toast: {
							message: `${r.name} ${r.enabled ? "enabled" : "disabled"}`,
							type: "success",
						},
					};
				}

				// Test-fire a routine
				if (
					interaction.type === "block_action" &&
					interaction.action_id === "test_routine" &&
					isValidId(interaction.value)
				) {
					const r = (await ctx.storage.routines.get(interaction.value)) as Routine | null;
					if (!r) {
						return {
							...(await buildAdminPage(ctx)),
							toast: { message: "Routine not found", type: "error" },
						};
					}
					const { executeRoutine } = await import("./engine.js");
					try {
						await executeRoutine(r, { _testFire: true }, ctx.site?.name ?? "Site", ctx);
						return {
							...(await buildAdminPage(ctx)),
							toast: { message: `Test-fired ${r.name}`, type: "success" },
						};
					} catch (err) {
						return {
							...(await buildAdminPage(ctx)),
							toast: {
								message: err instanceof Error ? err.message : String(err),
								type: "error",
							},
						};
					}
				}

				return { blocks: [] };
			},
		},
	},
});
