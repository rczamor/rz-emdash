import type { PluginContext } from "emdash";
import { describe, expect, it, vi } from "vitest";

import plugin from "../src/sandbox-entry.js";
import type { FormDefinition } from "../src/types.js";

const disabledUploadForm: FormDefinition = {
	id: "contact",
	title: "Contact",
	enabled: false,
	createdAt: "2026-01-01T00:00:00.000Z",
	updatedAt: "2026-01-01T00:00:00.000Z",
	fields: [
		{
			name: "attachment",
			type: "file",
			label: "Attachment",
			accept: "text/plain",
		},
	],
};

describe("public upload route", () => {
	it("rejects uploads for disabled forms before writing media", async () => {
		const upload = vi.fn(async () => ({ mediaId: "m1" }));
		const form = new FormData();
		form.set("formId", "contact");
		form.set("field", "attachment");
		form.set("file", new File(["hello"], "hello.txt", { type: "text/plain" }));

		const ctx = {
			storage: {
				forms: { get: async () => disabledUploadForm },
			},
			media: { upload },
			log: { error: () => {} },
		} as unknown as PluginContext;

		const result = await plugin.routes.upload.handler(
			{
				input: null,
				request: new Request("http://localhost/_emdash/api/plugins/webform/upload", {
					method: "POST",
					body: form,
				}),
			},
			ctx,
		);

		expect(result).toEqual({ ok: false, error: "Form is disabled" });
		expect(upload).not.toHaveBeenCalled();
	});
});
