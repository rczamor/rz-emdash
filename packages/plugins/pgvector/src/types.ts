/**
 * pgvector plugin types.
 *
 * Embeddings are partitioned across one table per dimension —
 * `pgvector_embeddings_<N>` — so an install can hold 1536-dim
 * OpenAI vectors alongside, say, 3072-dim large vectors and have
 * each indexed correctly.
 *
 * Tables are auto-created on first use of a dimension.
 */

export type IndexType = "hnsw" | "ivfflat";

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
	/** JSONB containment filter on the metadata column. */
	metadata?: Record<string, unknown>;
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
	byDimension: Record<string, number>;
}

export interface AutoEmbedConfig {
	/** Content fields to concatenate into the embedding input (in order). */
	fields: string[];
	/** Embedding model to call via openrouter. */
	model: string;
	/** Field name on the content item that supplies the source_id. Defaults to "id". */
	idField?: string;
}
