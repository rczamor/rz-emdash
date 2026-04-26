/**
 * PGVector Plugin for EmDash CMS.
 *
 * Embedding storage + similarity search backed by Postgres pgvector
 * with HNSW indexing. Postgres-only by design — emdash core can run
 * on SQLite, but this plugin assumes Postgres + the `vector`
 * extension. A SQLite fallback was rejected during planning: half-good
 * vector search is worse than no vector search.
 *
 * Schema is owned by the plugin (table `pgvector_embeddings`,
 * indexes incl. HNSW with `vector_cosine_ops`). The plugin opens its
 * own pg.Pool using the same PG* env vars emdash core uses, so no
 * additional configuration is required.
 *
 * Single dimension per install. Configurable via env var
 * `PGVECTOR_DIMENSION` (default 1536). Multi-dimension installs
 * would need separate tables per dimension; out of scope for v1.
 *
 * The plugin assumes the Postgres user has CREATE EXTENSION
 * privileges on first init (required to create the `vector`
 * extension if it doesn't exist).
 *
 * Companion: emdash core's `postgres()` adapter must be configured.
 * The plugin's connection pool is independent from core's; it only
 * shares env-var configuration.
 */

import type { PluginDescriptor } from "emdash";

export type {
	CollectionStats,
	EmbeddingRecord,
	SearchInput,
	SearchResult,
	UpsertEmbeddingInput,
} from "./types.js";

export interface PgVectorPluginOptions {
	/** Embedding dimension. Defaults to 1536 (OpenAI text-embedding-3-small). */
	dimension?: number;
}

export function pgvectorPlugin(_options: PgVectorPluginOptions = {}): PluginDescriptor {
	return {
		id: "pgvector",
		version: "0.0.1",
		format: "standard",
		entrypoint: "@emdash-cms/plugin-pgvector/sandbox",
		options: {},
		capabilities: ["read:content", "network:fetch"],
		// network:fetch — automation actions optionally call openrouter
		// for embedding generation
		allowedHosts: ["localhost", "127.0.0.1", "*"],
		adminPages: [{ path: "/pgvector", label: "Vector store", icon: "search" }],
	};
}
