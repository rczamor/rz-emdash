/**
 * Default validators shipped with the runs plugin.
 *
 * `seo` runs the same heuristics as the `seo_score` tool but as a
 * pre-publish gate: it never blocks (always `warn` at worst), but it
 * surfaces issues in the approval UI so the human can decide.
 *
 * Brand and moderation validators live in their owning plugins (a
 * `@emdash-cms/plugin-brand` validator and `@emdash-cms/plugin-ai-moderation`
 * validator can register themselves at module load).
 */

import { registerValidator, type Validator, type ValidationFinding } from "./validators.js";

function htmlToText(html: string): string {
	return html
		.replace(/<script[^>]*>[\s\S]*?<\/script>/gi, " ")
		.replace(/<style[^>]*>[\s\S]*?<\/style>/gi, " ")
		.replace(/<[^>]+>/g, " ")
		.replace(/\s+/g, " ")
		.trim();
}

function asString(v: unknown): string {
	return typeof v === "string" ? v : "";
}

const seoValidator: Validator = {
	id: "seo",
	name: "SEO heuristics",
	async run({ data }) {
		const findings: ValidationFinding[] = [];
		const title = asString(data.title);
		const description = asString(data.description);
		const slug = asString(data.slug);
		const body = asString(data.body);
		const text = body.includes("<") ? htmlToText(body) : body;

		if (!title) {
			findings.push({ severity: "fail", source: "seo", message: "Missing title" });
		} else if (title.length < 30 || title.length > 70) {
			findings.push({
				severity: "warn",
				source: "seo",
				message: `Title length ${title.length} chars (recommended 30-70)`,
			});
		}

		if (!description) {
			findings.push({ severity: "warn", source: "seo", message: "Missing meta description" });
		}

		if (slug && slug.length > 75) {
			findings.push({ severity: "warn", source: "seo", message: "Slug exceeds 75 chars" });
		}

		const wordCount = text.split(/\s+/).filter(Boolean).length;
		if (wordCount > 0 && wordCount < 200) {
			findings.push({
				severity: "warn",
				source: "seo",
				message: `Body is short (${wordCount} words; recommended 200+)`,
			});
		}

		if (body.includes("<")) {
			const h1Count = (body.match(/<h1\b/gi) ?? []).length;
			if (h1Count === 0) {
				findings.push({ severity: "warn", source: "seo", message: "No <h1> in body" });
			} else if (h1Count > 1) {
				findings.push({
					severity: "warn",
					source: "seo",
					message: `Multiple <h1> in body (${h1Count})`,
				});
			}
		}

		return findings;
	},
};

export function registerDefaultValidators(): void {
	registerValidator(seoValidator);
}
