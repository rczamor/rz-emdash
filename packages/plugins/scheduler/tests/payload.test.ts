import { describe, expect, it } from "vitest";

import { normaliseJobPayload } from "../src/payload.js";

describe("normaliseJobPayload", () => {
	it("accepts the public CreateJobInput payload shape", () => {
		expect(
			normaliseJobPayload({
				type: "publish",
				payload: { collection: "posts", contentId: "post-1" },
				runAt: "2030-01-01T00:00:00.000Z",
			}),
		).toEqual({ collection: "posts", contentId: "post-1" });
	});

	it("keeps backward compatibility with nested JobPayload values", () => {
		expect(
			normaliseJobPayload({
				type: "publish",
				payload: {
					type: "publish",
					payload: { collection: "posts", contentId: "post-1" },
				},
				runAt: "2030-01-01T00:00:00.000Z",
			}),
		).toEqual({ collection: "posts", contentId: "post-1" });
	});
});
