/**
 * Direct Postgres connection management for pgvector.
 *
 * Multi-dimension: one table per dimension, named
 * `pgvector_embeddings_<N>`. Tables and indexes are created lazily
 * the first time a dimension is seen.
 *
 * Index type: HNSW by default; configurable to IVFFlat via
 * PGVECTOR_INDEX_TYPE env var. HNSW gives better recall + faster
 * queries but slower builds; IVFFlat builds faster on huge corpora
 * but with worse recall.
 *
 * Metric: defaults to cosine (HNSW index built with
 * vector_cosine_ops). Search supports cosine / l2 / ip; non-cosine
 * queries fall back to sequential scan.
 */

import { Pool } from "pg";

import type {
	CollectionStats,
	EmbeddingRecord,
	IndexType,
	SearchInput,
	SearchResult,
	UpsertEmbeddingInput,
} from "./types.js";

const PGVECTOR_DB_STATE = Symbol.for("emdash.pluginPgvector.db");
const EMBEDDINGS_TABLE_RE = /^pgvector_embeddings_(\d+)$/;

interface PgvectorDbState {
	pool?: Pool;
	knownDimensions: Set<number>;
}

type PgvectorDbGlobal = typeof globalThis & {
	[PGVECTOR_DB_STATE]?: PgvectorDbState;
};

function getDbState(): PgvectorDbState {
	const global = globalThis as PgvectorDbGlobal;
	global[PGVECTOR_DB_STATE] ??= { knownDimensions: new Set() };
	return global[PGVECTOR_DB_STATE];
}

const knownDimensions = getDbState().knownDimensions;

function getPool(): Pool {
	const state = getDbState();
	if (!state.pool) {
		state.pool = new Pool({
			min: 0,
			max: 5,
			idleTimeoutMillis: 30_000,
		});
	}
	return state.pool;
}

/** @internal — exported for unit tests. */
export function tableName(dim: number): string {
	if (!Number.isInteger(dim) || dim <= 0 || dim > 16_000) {
		throw new Error(`Invalid embedding dimension: ${dim}`);
	}
	return `pgvector_embeddings_${dim}`;
}

/** @internal — exported for unit tests. */
export function indexType(): IndexType {
	const raw = (process.env.PGVECTOR_INDEX_TYPE ?? "hnsw").toLowerCase();
	return raw === "ivfflat" ? "ivfflat" : "hnsw";
}

export async function ensureSchemaForDimension(dim: number): Promise<void> {
	if (knownDimensions.has(dim)) return;
	const p = getPool();
	const client = await p.connect();
	const t = tableName(dim);
	const idx = indexType();
	try {
		await client.query("CREATE EXTENSION IF NOT EXISTS vector");
		await client.query(`
			CREATE TABLE IF NOT EXISTS ${t} (
				id TEXT PRIMARY KEY,
				source_collection TEXT NOT NULL,
				source_id TEXT NOT NULL,
				model TEXT NOT NULL,
				dimension INTEGER NOT NULL,
				embedding vector(${dim}),
				metadata JSONB NOT NULL DEFAULT '{}'::jsonb,
				created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
				UNIQUE(source_collection, source_id, model)
			)
		`);
		await client.query(`
			CREATE INDEX IF NOT EXISTS ${t}_lookup_idx
			ON ${t} (source_collection, source_id)
		`);
		await client.query(`
			CREATE INDEX IF NOT EXISTS ${t}_collection_idx
			ON ${t} (source_collection)
		`);
		await client.query(`
			CREATE INDEX IF NOT EXISTS ${t}_metadata_idx
			ON ${t} USING gin (metadata)
		`);
		// Vector index — HNSW or IVFFlat per env var
		if (idx === "hnsw") {
			await client.query(`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_indexes
						WHERE indexname = '${t}_hnsw_idx'
					) THEN
						CREATE INDEX ${t}_hnsw_idx ON ${t}
							USING hnsw (embedding vector_cosine_ops);
					END IF;
				END$$
			`);
		} else {
			await client.query(`
				DO $$
				BEGIN
					IF NOT EXISTS (
						SELECT 1 FROM pg_indexes
						WHERE indexname = '${t}_ivfflat_idx'
					) THEN
						CREATE INDEX ${t}_ivfflat_idx ON ${t}
							USING ivfflat (embedding vector_cosine_ops)
							WITH (lists = 100);
					END IF;
				END$$
			`);
		}
		knownDimensions.add(dim);
	} finally {
		client.release();
	}
}

/** @internal — exported for unit tests. */
export function toVectorLiteral(embedding: number[]): string {
	return `[${embedding.join(",")}]`;
}

/** @internal — exported for unit tests. */
export function newId(): string {
	return `emb_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export async function upsertEmbedding(input: UpsertEmbeddingInput): Promise<EmbeddingRecord> {
	const dim = input.embedding.length;
	await ensureSchemaForDimension(dim);
	const p = getPool();
	const id = newId();
	const t = tableName(dim);
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
		`INSERT INTO ${t}
			(id, source_collection, source_id, model, dimension, embedding, metadata)
		VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
		ON CONFLICT (source_collection, source_id, model) DO UPDATE SET
			embedding = EXCLUDED.embedding,
			dimension = EXCLUDED.dimension,
			metadata = EXCLUDED.metadata,
			updated_at = NOW()
		RETURNING id, source_collection, source_id, model, dimension, metadata, created_at, updated_at`,
		[id, input.source_collection, input.source_id, input.model, dim, vector, metadata],
	);
	const row = result.rows[0]!;
	return {
		...row,
		embedding: input.embedding,
		created_at: row.created_at.toISOString(),
		updated_at: row.updated_at.toISOString(),
	};
}

export async function bulkUpsertEmbeddings(
	inputs: UpsertEmbeddingInput[],
): Promise<{ inserted: number; updated: number; failed: number; errors: string[] }> {
	if (inputs.length === 0) return { inserted: 0, updated: 0, failed: 0, errors: [] };
	const dim = inputs[0]!.embedding.length;
	if (!inputs.every((i) => i.embedding.length === dim)) {
		throw new Error("Bulk upsert requires all embeddings to share the same dimension");
	}
	await ensureSchemaForDimension(dim);
	const p = getPool();
	const t = tableName(dim);

	let inserted = 0;
	let updated = 0;
	let failed = 0;
	const errors: string[] = [];

	const client = await p.connect();
	try {
		await client.query("BEGIN");
		for (const input of inputs) {
			try {
				const vector = toVectorLiteral(input.embedding);
				const metadata = JSON.stringify(input.metadata ?? {});
				const id = newId();
				const result = await client.query<{ inserted: boolean }>(
					`INSERT INTO ${t}
						(id, source_collection, source_id, model, dimension, embedding, metadata)
					VALUES ($1, $2, $3, $4, $5, $6::vector, $7::jsonb)
					ON CONFLICT (source_collection, source_id, model) DO UPDATE SET
						embedding = EXCLUDED.embedding,
						dimension = EXCLUDED.dimension,
						metadata = EXCLUDED.metadata,
						updated_at = NOW()
					RETURNING (xmax = 0) AS inserted`,
					[id, input.source_collection, input.source_id, input.model, dim, vector, metadata],
				);
				if (result.rows[0]?.inserted) inserted++;
				else updated++;
			} catch (err) {
				failed++;
				errors.push(err instanceof Error ? err.message : String(err));
			}
		}
		await client.query("COMMIT");
	} catch (err) {
		await client.query("ROLLBACK");
		throw err;
	} finally {
		client.release();
	}
	return { inserted, updated, failed, errors };
}

export async function searchEmbeddings(input: SearchInput): Promise<SearchResult[]> {
	const dim = input.embedding.length;
	await ensureSchemaForDimension(dim);
	const p = getPool();
	const t = tableName(dim);
	const k = Math.min(Math.max(input.k ?? 10, 1), 200);
	const vector = toVectorLiteral(input.embedding);
	const op = input.metric === "l2" ? "<->" : input.metric === "ip" ? "<#>" : "<=>";

	const params: unknown[] = [vector];
	const wheres: string[] = [];
	if (input.source_collection) {
		params.push(input.source_collection);
		wheres.push(`source_collection = $${params.length}`);
	}
	if (input.metadata && Object.keys(input.metadata).length > 0) {
		params.push(JSON.stringify(input.metadata));
		wheres.push(`metadata @> $${params.length}::jsonb`);
	}
	const where = wheres.length > 0 ? `WHERE ${wheres.join(" AND ")}` : "";
	params.push(k);

	const sql = `
		SELECT
			id,
			source_collection,
			source_id,
			metadata,
			(embedding ${op} $1::vector) AS score
		FROM ${t}
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
	options: { model?: string; dimension?: number } = {},
): Promise<number> {
	const p = getPool();
	const dims = options.dimension ? [options.dimension] : [...knownDimensions];
	let removed = 0;
	for (const dim of dims) {
		const t = tableName(dim);
		const params: unknown[] = [source_collection, source_id];
		let q = `DELETE FROM ${t} WHERE source_collection = $1 AND source_id = $2`;
		if (options.model) {
			params.push(options.model);
			q += ` AND model = $3`;
		}
		try {
			const result = await p.query(q, params);
			removed += result.rowCount ?? 0;
		} catch {
			// Table may not exist yet for that dim; ignore.
		}
	}
	return removed;
}

export async function listEmbeddings(
	source_collection: string,
	limit = 100,
): Promise<EmbeddingRecord[]> {
	const p = getPool();
	const records: EmbeddingRecord[] = [];
	for (const dim of knownDimensions) {
		const t = tableName(dim);
		try {
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
				FROM ${t}
				WHERE source_collection = $1
				ORDER BY created_at DESC
				LIMIT $2`,
				[source_collection, limit],
			);
			for (const r of result.rows) {
				records.push({
					...r,
					embedding: [],
					created_at: r.created_at.toISOString(),
					updated_at: r.updated_at.toISOString(),
				});
			}
		} catch {
			/* skip */
		}
	}
	return records.toSorted((a, b) => b.created_at.localeCompare(a.created_at)).slice(0, limit);
}

export async function discoverDimensions(): Promise<number[]> {
	const p = getPool();
	const result = await p.query<{ tablename: string }>(
		`SELECT tablename FROM pg_tables
		WHERE schemaname = 'public'
		AND tablename ~ '^pgvector_embeddings_[0-9]+$'`,
	);
	for (const row of result.rows) {
		const m = row.tablename.match(EMBEDDINGS_TABLE_RE);
		if (m) knownDimensions.add(Number(m[1]));
	}
	return [...knownDimensions].toSorted((a, b) => a - b);
}

export async function totalCount(): Promise<number> {
	const p = getPool();
	let total = 0;
	for (const dim of knownDimensions) {
		const t = tableName(dim);
		try {
			const result = await p.query<{ c: string }>(`SELECT COUNT(*)::text AS c FROM ${t}`);
			total += Number(result.rows[0]?.c ?? 0);
		} catch {
			/* skip */
		}
	}
	return total;
}

export async function statsByCollection(): Promise<CollectionStats[]> {
	const p = getPool();
	const accum = new Map<string, { count: number; byDim: Record<string, number> }>();
	for (const dim of knownDimensions) {
		const t = tableName(dim);
		try {
			const result = await p.query<{ collection: string; c: string }>(
				`SELECT source_collection AS collection, COUNT(*)::text AS c
				FROM ${t}
				GROUP BY source_collection`,
			);
			for (const r of result.rows) {
				const entry = accum.get(r.collection) ?? { count: 0, byDim: {} };
				entry.count += Number(r.c);
				entry.byDim[String(dim)] = Number(r.c);
				accum.set(r.collection, entry);
			}
		} catch {
			/* skip */
		}
	}
	const out: CollectionStats[] = [];
	for (const [collection, { count, byDim }] of accum) {
		out.push({ collection, count, byDimension: byDim });
	}
	return out.toSorted((a, b) => a.collection.localeCompare(b.collection));
}

export function getKnownDimensions(): number[] {
	return [...knownDimensions].toSorted((a, b) => a - b);
}
