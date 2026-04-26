/**
 * Direct Postgres connection management for pgvector.
 *
 * Uses pg.Pool. Same connection details as emdash core (PGHOST,
 * PGUSER, PGPASSWORD, PGDATABASE, PGPORT — pg's own env-var fallback).
 * Owns its schema: `pgvector_embeddings` table + HNSW index.
 *
 * The Pool is lazily created on first use and reused across
 * requests. Plugin lifecycle hooks could close it on deactivate but
 * for v1 we leak the pool — emdash's process lifetime owns it.
 */

import { Pool } from "pg";

import type {
	CollectionStats,
	EmbeddingRecord,
	SearchInput,
	SearchResult,
	UpsertEmbeddingInput,
} from "./types.js";

let pool: Pool | undefined;

interface PoolOptions {
	dimension?: number;
}

function getPool(): Pool {
	if (!pool) {
		pool = new Pool({
			min: 0,
			max: 5,
			idleTimeoutMillis: 30_000,
		});
	}
	return pool;
}

export async function ensureSchema(options: PoolOptions): Promise<void> {
	const dimension = options.dimension ?? 1536;
	const p = getPool();
	const client = await p.connect();
	try {
		await client.query("CREATE EXTENSION IF NOT EXISTS vector");
		await client.query(`
			CREATE TABLE IF NOT EXISTS pgvector_embeddings (
				id TEXT PRIMARY KEY,
				source_collection TEXT NOT NULL,
				source_id TEXT NOT NULL,
				model TEXT NOT NULL,
				dimension INTEGER NOT NULL,
				embedding vector(${dimension}),
				metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				UNIQUE(source_collection, source_id, model)
			)
		`);
		await client.query(`
			CREATE INDEX IF NOT EXISTS pgvector_embeddings_lookup_idx
			ON pgvector_embeddings (source_collection, source_id)
		`);
		await client.query(`
			CREATE INDEX IF NOT EXISTS pgvector_embeddings_collection_idx
			ON pgvector_embeddings (source_collection)
		`);
		// HNSW with cosine distance — best for normalised embeddings
		// (OpenAI / Anthropic / voyage are all unit-normalised by
		// default). Build with default m=16 / ef_construction=64.
		await client.query(`
			DO $$
			BEGIN
				IF NOT EXISTS (
					SELECT 1 FROM pg_indexes
					WHERE indexname = 'pgvector_embeddings_hnsw_idx'
				) THEN
					CREATE INDEX pgvector_embeddings_hnsw_idx
					ON pgvector_embeddings
					USING hnsw (embedding vector_cosine_ops);
				END IF;
			END$$
		`);
	} finally {
		client.release();
	}
}

function toVectorLiteral(embedding: number[]): string {
	// pgvector accepts the literal "[1,2,3]" — JS array stringifies fine.
	return `[${embedding.join(",")}]`;
}

function newId(): string {
	return `emb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function upsertEmbedding(input: UpsertEmbeddingInput): Promise<EmbeddingRecord> {
	const p = getPool();
	const id = newId();
	const dimension = input.embedding.length;
	const vector = toVectorLiteral(input.embedding);
	const metadata = JSON.stringify(input.metadata ?? {});

	const result = await p.query<{
		id: string;
		source_collection: string;
		source_id: string;
		model: string;
		dimension: number;
		metadata: Record<string, unknown>;
		created_at: Date;
		updated_at: Date;
	}>(
		`INSERT INTO pgvector_embeddings
			(id, source_collection, source_id, model, dimension, embedding, metadata)
		VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
		ON CONFLICT (source_collection, source_id, model) DO UPDATE SET
			embedding = EXCLUDED.embedding,
			dimension = EXCLUDED.dimension,
			metadata = EXCLUDED.metadata,
			updated_at = NOW()
		RETURNING id, source_collection, source_id, model, dimension, metadata, created_at, updated_at`,
		[id, input.source_collection, input.source_id, input.model, dimension, vector, metadata],
	);
	const row = result.rows[0]!;
	return {
		...row,
		embedding: input.embedding,
		created_at: row.created_at.toISOString(),
		updated_at: row.updated_at.toISOString(),
	};
}

export async function searchEmbeddings(input: SearchInput): Promise<SearchResult[]> {
	const p = getPool();
	const k = Math.min(Math.max(input.k ?? 10, 1), 200);
	const vector = toVectorLiteral(input.embedding);
	const op = input.metric === "l2" ? "<->" : input.metric === "ip" ? "<#>" : "<=>";

	const params: unknown[] = [vector];
	let where = "";
	if (input.source_collection) {
		params.push(input.source_collection);
		where = `WHERE source_collection = $${params.length}`;
	}
	params.push(k);

	const sql = `
		SELECT
			id,
			source_collection,
			source_id,
			metadata,
			(embedding ${op} $1::vector) AS score
		FROM pgvector_embeddings
		${where}
		ORDER BY embedding ${op} $1::vector
		LIMIT $${params.length}
	`;

	const result = await p.query<{
		id: string;
		source_collection: string;
		source_id: string;
		metadata: Record<string, unknown>;
		score: number;
	}>(sql, params);
	return result.rows.map((r) => ({
		id: r.id,
		source_collection: r.source_collection,
		source_id: r.source_id,
		score: typeof r.score === "string" ? Number(r.score) : r.score,
		metadata: r.metadata,
	}));
}

export async function deleteEmbedding(
	source_collection: string,
	source_id: string,
	model?: string,
): Promise<number> {
	const p = getPool();
	if (model) {
		const result = await p.query(
			`DELETE FROM pgvector_embeddings WHERE source_collection = $1 AND source_id = $2 AND model = $3`,
			[source_collection, source_id, model],
		);
		return result.rowCount ?? 0;
	}
	const result = await p.query(
		`DELETE FROM pgvector_embeddings WHERE source_collection = $1 AND source_id = $2`,
		[source_collection, source_id],
	);
	return result.rowCount ?? 0;
}

export async function listEmbeddings(
	source_collection: string,
	limit = 100,
): Promise<EmbeddingRecord[]> {
	const p = getPool();
	const result = await p.query<{
		id: string;
		source_collection: string;
		source_id: string;
		model: string;
		dimension: number;
		metadata: Record<string, unknown>;
		created_at: Date;
		updated_at: Date;
	}>(
		`SELECT id, source_collection, source_id, model, dimension, metadata, created_at, updated_at
		FROM pgvector_embeddings
		WHERE source_collection = $1
		ORDER BY created_at DESC
		LIMIT $2`,
		[source_collection, limit],
	);
	return result.rows.map((r) => ({
		...r,
		embedding: [], // not returned in list calls (heavy)
		created_at: r.created_at.toISOString(),
		updated_at: r.updated_at.toISOString(),
	}));
}

export async function totalCount(): Promise<number> {
	const p = getPool();
	const result = await p.query<{ c: string }>(
		"SELECT COUNT(*)::text AS c FROM pgvector_embeddings",
	);
	return Number(result.rows[0]?.c ?? 0);
}

export async function statsByCollection(): Promise<CollectionStats[]> {
	const p = getPool();
	const result = await p.query<{ collection: string; c: string }>(
		`SELECT source_collection AS collection, COUNT(*)::text AS c
		FROM pgvector_embeddings
		GROUP BY source_collection
		ORDER BY collection`,
	);
	return result.rows.map((r) => ({ collection: r.collection, count: Number(r.c) }));
}
