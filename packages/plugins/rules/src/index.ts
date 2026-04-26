/**
 * Rules Plugin for EmDash CMS
 *
 * EmDash port of Drupal's Rules module — reframed as Claude-Code-routine-style
 * YAML/JSON specs. A routine is a JSON document with three parts:
 *
 *   - trigger:  what fires it (an emdash hook event, or a cron schedule)
 *   - filter:   structured DSL to limit when the routine runs (optional)
 *   - actions:  list of side-effects to execute in order
 *
 * Example: notify Slack when a featured post is published.
 *
 *   {
 *     "id": "notify-featured",
 *     "name": "Notify on featured post publish",
 *     "enabled": true,
 *     "trigger": { "on": "content:afterPublish" },
 *     "filter": {
 *       "all": [
 *         { "eq": { "path": "event.collection",            "value": "posts" } },
 *         { "eq": { "path": "event.content.featured",      "value": true   } }
 *       ]
 *     },
 *     "actions": [
 *       {
 *         "type": "webhook",
 *         "url": "https://hooks.slack.com/services/…",
 *         "body": "{\"text\": \"New featured post: {event.content.title}\"}"
 *       }
 *     ]
 *   }
 *
 * Token strings inside actions go through `@emdash-cms/plugin-tokens`. The
 * full event is bound to `{event.…}` and site metadata to `{site.…}`.
 *
 * Built-in actions: email, webhook, log, kv:set. More can be added by
 * forking this plugin (a runtime registry is on the roadmap).
 */

import type { PluginDescriptor } from "emdash";

export type {
	Action,
	EmailAction,
	EventTrigger,
	EventTriggerName,
	Filter,
	KvSetAction,
	LogAction,
	Routine,
	Trigger,
	WebhookAction,
} from "./types.js";

export function rulesPlugin(): PluginDescriptor {
	return {
		id: "rules",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-rules/sandbox",
		options: {},
		capabilities: [
			"email:send",
			"email:intercept",
			"network:fetch",
			"read:content",
			"write:content",
			"read:media",
			"write:media",
			"read:users",
		],
		// allowedHosts is intentionally permissive here — webhook targets are
		// authored by trusted admins, not end users. In sandboxed mode this
		// would need tightening: register only known hosts.
		allowedHosts: ["*"],
		storage: {
			routines: { indexes: ["enabled", "triggerOn", "createdAt"] },
		},
		adminPages: [{ path: "/rules", label: "Rules", icon: "git-branch" }],
		adminWidgets: [{ id: "rules-recent", title: "Recent rule runs", size: "half" }],
	};
}
