/**
 * Geocoding — turn addresses into lat/lng (and back). Pluggable provider
 * abstraction; Nominatim default (free, OSM-based, attribution required).
 *
 * Other providers can be passed via plugin options when the integration
 * pattern is stable enough; for v1, Nominatim is wired in directly.
 *
 * All requests go through `ctx.http.fetch` so the network:fetch
 * capability gate applies. Results are cached in plugin storage keyed
 * by the normalised query string with a 30-day TTL.
 */

import type { PluginContext } from "emdash";

import { formatAddress } from "./util.js";
import type { Address } from "./util.js";

export interface GeocodeResult {
	lat: number;
	lng: number;
	formatted: string;
	provider: "nominatim";
	confidence?: number;
}

export interface ReverseResult {
	address: Record<string, string>;
	formatted: string;
	provider: "nominatim";
}

interface CacheRecord {
	query: string;
	result: GeocodeResult | ReverseResult;
	createdAt: string;
}

const CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const NOMINATIM_USER_AGENT = "emdash-cms-plugin-address/0.0.1";

function cacheKey(prefix: string, payload: string): string {
	// Limited cache key length; storage IDs are typically up to 256 chars.
	const trimmed = payload.replace(/\s+/g, " ").trim().toLowerCase();
	return `${prefix}:${trimmed.slice(0, 200)}`;
}

async function readCache(
	key: string,
	ctx: PluginContext,
): Promise<GeocodeResult | ReverseResult | null> {
	const record = (await ctx.storage.geocache.get(key)) as CacheRecord | null;
	if (!record) return null;
	const age = Date.now() - new Date(record.createdAt).getTime();
	if (age > CACHE_TTL_MS) {
		await ctx.storage.geocache.delete(key);
		return null;
	}
	return record.result;
}

async function writeCache(
	key: string,
	query: string,
	result: GeocodeResult | ReverseResult,
	ctx: PluginContext,
): Promise<void> {
	const record: CacheRecord = { query, result, createdAt: new Date().toISOString() };
	await ctx.storage.geocache.put(key, record);
}

function normaliseQuery(address: Address, country?: string): string {
	if (country) {
		const formatted = formatAddress(address, country).replace(/\n/g, ", ");
		if (formatted) return formatted;
	}
	return [
		address.addressLine1,
		address.addressLine2,
		address.locality,
		address.administrativeArea,
		address.postalCode,
	]
		.filter(Boolean)
		.join(", ");
}

// ── Nominatim provider ──────────────────────────────────────────────────────

interface NominatimSearchHit {
	lat: string;
	lon: string;
	display_name: string;
	importance?: number;
}

interface NominatimReverseHit {
	display_name: string;
	address?: Record<string, string>;
}

async function nominatimSearch(
	query: string,
	ctx: PluginContext,
): Promise<GeocodeResult | null> {
	if (!ctx.http) throw new Error("network:fetch capability missing");
	const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(query)}&format=json&limit=1`;
	const res = await ctx.http.fetch(url, {
		headers: { "User-Agent": NOMINATIM_USER_AGENT, Accept: "application/json" },
	});
	if (!res.ok) {
		ctx.log.warn("Nominatim search failed", { status: res.status });
		return null;
	}
	const hits = (await res.json()) as NominatimSearchHit[];
	const hit = hits[0];
	if (!hit) return null;
	return {
		lat: Number(hit.lat),
		lng: Number(hit.lon),
		formatted: hit.display_name,
		provider: "nominatim",
		confidence: hit.importance,
	};
}

async function nominatimReverse(
	lat: number,
	lng: number,
	ctx: PluginContext,
): Promise<ReverseResult | null> {
	if (!ctx.http) throw new Error("network:fetch capability missing");
	const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json`;
	const res = await ctx.http.fetch(url, {
		headers: { "User-Agent": NOMINATIM_USER_AGENT, Accept: "application/json" },
	});
	if (!res.ok) {
		ctx.log.warn("Nominatim reverse failed", { status: res.status });
		return null;
	}
	const hit = (await res.json()) as NominatimReverseHit;
	if (!hit?.display_name) return null;
	return {
		address: hit.address ?? {},
		formatted: hit.display_name,
		provider: "nominatim",
	};
}

// ── Public API ──────────────────────────────────────────────────────────────

export async function geocode(
	address: Address,
	options: { country?: string; bypassCache?: boolean } = {},
	ctx: PluginContext,
): Promise<GeocodeResult | null> {
	const query = normaliseQuery(address, options.country);
	if (!query) return null;
	const key = cacheKey("g", query);
	if (!options.bypassCache) {
		const cached = await readCache(key, ctx);
		if (cached && "lat" in cached) return cached;
	}
	const result = await nominatimSearch(query, ctx);
	if (result) await writeCache(key, query, result, ctx);
	return result;
}

export async function reverseGeocode(
	lat: number,
	lng: number,
	options: { bypassCache?: boolean } = {},
	ctx: PluginContext,
): Promise<ReverseResult | null> {
	const query = `${lat.toFixed(6)},${lng.toFixed(6)}`;
	const key = cacheKey("r", query);
	if (!options.bypassCache) {
		const cached = await readCache(key, ctx);
		if (cached && "address" in cached) return cached;
	}
	const result = await nominatimReverse(lat, lng, ctx);
	if (result) await writeCache(key, query, result, ctx);
	return result;
}
