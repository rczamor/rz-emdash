/**
 * Design System Plugin for EmDash CMS.
 *
 * Implements Google Labs' DESIGN.md spec
 * (https://github.com/google-labs-code/design.md), Apache 2.0,
 * released 2026-04-21. Companion to AGENTS.md, designed as a
 * "system prompt for design" any coding agent can consume.
 *
 * Pattern: the user keeps `DESIGN.md` in their project root (Git-tracked).
 * On build or via CLI, the file is POSTed to this plugin's
 * `design.parse` route. The plugin parses + validates + caches the
 * result in plugin KV. Agents call `design.systemPrompt` to fetch the
 * compact markdown block to inject into their system prompt.
 *
 * Validation findings (errors / warnings / info) are returned by
 * `design.validate` and rendered in the admin Block Kit page.
 *
 * Tailwind exporter (`design.exportTailwind`) emits a tailwind.config
 * fragment from the design tokens, suitable for `theme.extend`.
 *
 * WCAG contrast checks are best-effort against keys named
 * text/foreground/onX vs background/bg/surface/primary/secondary.
 */

import type { PluginDescriptor } from "emdash";

export type {
	DesignSystemFrontmatter,
	DesignSystemSection,
	ParsedDesignSystem,
	ResolvedTokens,
	ValidationFinding,
	ValidationLevel,
	ValidationReport,
} from "./types.js";

export {
	assembleDesignSystemBlock,
	contrastRatio,
	exportTailwindConfig,
	parseDesignSystem,
	resolveTokens,
	validateDesignSystem,
} from "./parse.js";

export function designSystemPlugin(): PluginDescriptor {
	return {
		id: "design-system",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-design-system/sandbox",
		options: {},
		adminPages: [{ path: "/design", label: "Design system", icon: "palette" }],
	};
}
