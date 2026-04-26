/**
 * pgvector plugin types.
 *
 * Embeddings are stored in a dedicated table `pgvector_embeddings` in
 * the same Postgres instance emdash core uses (same PG* env vars).
 * The plugin owns its schema — pg.Pool is opened directly rather
 * than going through plugin storage, because plugin storage can't
 * declare custom column types like `vector(N)` or HNSW indexes.
 *
 * Single dimension per install (configurable via plugin options).
 * Default 1536 (OpenAI text-embedding-3-small / voyage-3-lite).
 */

export interface EmbeddingRecord {
	id: string;
	source_collection: string;
	source_id: string;
	model: string;
	dimension: number;
	embedding: number[];
	metadata: Record<string, unknown>;
	created_at: string;
	updated_at: string;
}

export interface UpsertEmbeddingInput {
	source_collection: string;
	source_id: string;
	model: string;
	embedding: number[];
	metadata?: Record<string, unknown>;
}

export interface SearchInput {
	embedding: number[];
	k?: number;
	source_collection?: string;
	metric?: "cosine" | "l2" | "ip";
}

export interface SearchResult {
	id: string;
	source_collection: string;
	source_id: string;
	score: number;
	metadata: Record<string, unknown>;
}

export interface CollectionStats {
	collection: string;
	count: number;
}
