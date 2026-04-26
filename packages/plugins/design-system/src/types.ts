/**
 * Google Labs DESIGN.md types.
 *
 * Spec: https://github.com/google-labs-code/design.md/blob/main/docs/spec.md
 *
 * The frontmatter is optional + extensible; body sections are
 * markdown. Validators emit structured findings rather than throwing
 * so callers (admin pages, CI) can render them.
 */

export interface ColorToken {
	value: string;
	description?: string;
}

export interface TypographyToken {
	fontFamily?: string;
	fontSize?: string;
	fontWeight?: number | string;
	lineHeight?: string | number;
	letterSpacing?: string;
	fontFeature?: string;
	fontVariation?: string;
}

export interface ComponentVariantToken {
	[property: string]: string | number;
}

export interface ComponentToken {
	[variantOrProperty: string]: string | number | ComponentVariantToken;
}

export interface DesignSystemFrontmatter {
	version?: string;
	name?: string;
	description?: string;
	colors?: Record<string, string | ColorToken>;
	typography?: Record<string, TypographyToken | string>;
	spacing?: Record<string, string>;
	rounded?: Record<string, string>;
	components?: Record<string, ComponentToken>;
	[other: string]: unknown;
}

export interface DesignSystemSection {
	heading: string;
	level: number;
	body: string;
}

export interface ParsedDesignSystem {
	frontmatter: DesignSystemFrontmatter;
	sections: DesignSystemSection[];
	bodyMarkdown: string;
	rawSource: string;
	parsedAt: string;
}

export type ValidationLevel = "error" | "warning" | "info";

export interface ValidationFinding {
	level: ValidationLevel;
	code: string;
	message: string;
	location?: string;
}

export interface ValidationReport {
	ok: boolean;
	findings: ValidationFinding[];
}

/** Resolved token tree — frontmatter values with `{path.refs}` substituted. */
export type ResolvedTokens = DesignSystemFrontmatter;
