import type { FieldDef } from "../src/types.js";

/** Typed test factory — keeps `type` literal so option/required typing flows through. */
export function f<T extends FieldDef["type"]>(
	def: { name: string; type: T; label: string } & Partial<FieldDef>,
): FieldDef {
	return def as FieldDef;
}

export const text = (extra: Partial<FieldDef> = {}): FieldDef =>
	f({ name: "x", type: "text", label: "X", ...extra });
