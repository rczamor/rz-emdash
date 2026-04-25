/**
 * Resend Email Provider Plugin for EmDash CMS
 *
 * Registers the exclusive `email:deliver` hook and routes outgoing
 * email through https://resend.com via their HTTP API.
 *
 * Configure with an API key + verified `from` address:
 *
 *     resendPlugin({
 *         apiKey: process.env.RESEND_API_KEY,
 *         from: "EmDash <noreply@yourdomain.com>",
 *     })
 *
 * If `apiKey` is missing the deliver hook throws — making the
 * misconfiguration visible at send time rather than silently dropping
 * mail.
 */

import type { PluginDescriptor, ResolvedPlugin } from "emdash";
import { definePlugin } from "emdash";

const RESEND_API_URL = "https://api.resend.com/emails";

export interface ResendPluginOptions {
	/** Resend API key — read from process.env.RESEND_API_KEY by default. */
	apiKey?: string;
	/**
	 * Default From address (e.g. "EmDash <noreply@yourdomain.com>").
	 * Must use a domain you've verified in Resend.
	 */
	from?: string;
	/** Optional ReplyTo address applied when the message has none of its own. */
	replyTo?: string;
}

export function createPlugin(options: ResendPluginOptions = {}): ResolvedPlugin {
	const apiKey = options.apiKey ?? process.env.RESEND_API_KEY;
	const fromAddress = options.from ?? process.env.RESEND_FROM ?? "onboarding@resend.dev";
	const replyTo = options.replyTo ?? process.env.RESEND_REPLY_TO;

	return definePlugin({
		id: "resend",
		version: "0.0.1",

		capabilities: ["email:provide", "network:fetch"],
		allowedHosts: ["api.resend.com"],

		hooks: {
			"email:deliver": {
				exclusive: true,
				handler: async (event, ctx) => {
					if (!apiKey) {
						throw new Error(
							"[resend] RESEND_API_KEY is not set — refusing to deliver email",
						);
					}

					const { message, source } = event;
					const body: Record<string, unknown> = {
						from: fromAddress,
						to: message.to,
						subject: message.subject,
						text: message.text,
					};
					if (message.html) body.html = message.html;
					if (replyTo) body.reply_to = replyTo;

					const response = await fetch(RESEND_API_URL, {
						method: "POST",
						headers: {
							Authorization: `Bearer ${apiKey}`,
							"Content-Type": "application/json",
						},
						body: JSON.stringify(body),
					});

					if (!response.ok) {
						const errText = await response.text().catch(() => "<unreadable>");
						ctx.log.error("Resend delivery failed", {
							status: response.status,
							source,
							to: message.to,
							body: errText.slice(0, 500),
						});
						throw new Error(
							`Resend API ${response.status}: ${errText.slice(0, 200)}`,
						);
					}

					ctx.log.info("Email delivered via Resend", {
						source,
						to: message.to,
						subject: message.subject,
					});
				},
			},
		},
	});
}

export default createPlugin;

export function resendPlugin(
	options: ResendPluginOptions = {},
): PluginDescriptor<ResendPluginOptions> {
	return {
		id: "resend",
		version: "0.0.1",
		format: "native",
		entrypoint: "@emdash-cms/plugin-resend",
		options,
	};
}
