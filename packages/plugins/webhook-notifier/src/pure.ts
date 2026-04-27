/**
 * Pure helpers — extracted so unit tests can import them without
 * pulling in the `emdash` runtime through `sandbox-entry.ts`.
 *
 * `validateWebhookUrl` provides SSRF protection: rejects non-http(s)
 * schemes, blocked hostnames (localhost, cloud metadata), and private/
 * loopback IP ranges (IPv4 + IPv6).
 *
 * `sendWebhook` is the retry loop with exponential backoff. It calls
 * `validateWebhookUrl` first, so a malicious URL never reaches `fetchFn`.
 */

export interface WebhookPayload {
	event: string;
	timestamp: string;
	collection?: string;
	resourceId: string;
	resourceType: "content" | "media";
	data?: Record<string, unknown>;
	metadata?: Record<string, unknown>;
}

export interface WebhookLog {
	info: (msg: string, meta?: Record<string, unknown>) => void;
	warn: (msg: string, meta?: Record<string, unknown>) => void;
	error: (msg: string, meta?: Record<string, unknown>) => void;
}

export type WebhookFetch = (url: string, init?: RequestInit) => Promise<Response>;

const IPV6_BRACKET_PATTERN = /^\[|\]$/g;
const BLOCKED_HOSTNAMES = new Set(["localhost", "metadata.google.internal", "[::1]"]);
const PRIVATE_RANGES = [
	{ start: (127 << 24) >>> 0, end: ((127 << 24) | 0x00ffffff) >>> 0 },
	{ start: (10 << 24) >>> 0, end: ((10 << 24) | 0x00ffffff) >>> 0 },
	{ start: ((172 << 24) | (16 << 16)) >>> 0, end: ((172 << 24) | (31 << 16) | 0xffff) >>> 0 },
	{ start: ((192 << 24) | (168 << 16)) >>> 0, end: ((192 << 24) | (168 << 16) | 0xffff) >>> 0 },
	{ start: ((169 << 24) | (254 << 16)) >>> 0, end: ((169 << 24) | (254 << 16) | 0xffff) >>> 0 },
	{ start: 0, end: 0x00ffffff },
];

export function validateWebhookUrl(url: string): void {
	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new Error("Invalid webhook URL");
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`Webhook URL scheme '${parsed.protocol}' is not allowed`);
	}
	const hostname = parsed.hostname.replace(IPV6_BRACKET_PATTERN, "");
	if (BLOCKED_HOSTNAMES.has(hostname.toLowerCase())) {
		throw new Error("Webhook URLs targeting internal hosts are not allowed");
	}
	const parts = hostname.split(".");
	if (parts.length === 4) {
		const nums = parts.map(Number);
		if (nums.every((n) => !isNaN(n) && n >= 0 && n <= 255)) {
			const ip = ((nums[0]! << 24) | (nums[1]! << 16) | (nums[2]! << 8) | nums[3]!) >>> 0;
			if (PRIVATE_RANGES.some((r) => ip >= r.start && ip <= r.end)) {
				throw new Error("Webhook URLs targeting private IP addresses are not allowed");
			}
		}
	}
	if (
		hostname === "::1" ||
		hostname.startsWith("fe80:") ||
		hostname.startsWith("fc") ||
		hostname.startsWith("fd")
	) {
		throw new Error("Webhook URLs targeting internal addresses are not allowed");
	}
}

export async function sendWebhook(
	fetchFn: WebhookFetch,
	log: WebhookLog,
	url: string,
	payload: WebhookPayload,
	token: string | undefined,
	maxRetries: number,
): Promise<{ success: boolean; status?: number; error?: string }> {
	validateWebhookUrl(url);

	let lastError: string | undefined;
	let lastStatus: number | undefined;

	for (let attempt = 1; attempt <= maxRetries; attempt++) {
		try {
			const headers: Record<string, string> = {
				"Content-Type": "application/json",
				"X-EmDash-Event": payload.event,
			};
			if (token) headers["Authorization"] = `Bearer ${token}`;

			const response = await fetchFn(url, {
				method: "POST",
				headers,
				body: JSON.stringify(payload),
			});

			lastStatus = response.status;
			if (response.ok) {
				log.info(`Delivered ${payload.event} to ${url} (${response.status})`);
				return { success: true, status: response.status };
			}

			lastError = `HTTP ${response.status}: ${response.statusText}`;
			log.warn(`Attempt ${attempt}/${maxRetries} failed: ${lastError}`);
		} catch (error) {
			lastError = error instanceof Error ? error.message : "Unknown error";
			log.warn(`Attempt ${attempt}/${maxRetries} failed: ${lastError}`);
		}

		if (attempt < maxRetries) {
			await new Promise((resolve) => setTimeout(resolve, 100 * Math.pow(2, attempt - 1)));
		}
	}

	log.error(`Failed to deliver ${payload.event} after ${maxRetries} attempts`);
	return { success: false, status: lastStatus, error: lastError };
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function getString(value: unknown, key: string): string | undefined {
	if (!isRecord(value)) return undefined;
	const v = value[key];
	return typeof v === "string" ? v : undefined;
}
