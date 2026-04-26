/**
 * Langfuse plugin types.
 *
 * Mirrors the Langfuse Public Ingestion API shape so we can pass
 * payloads through without translation.
 *
 * Reference: https://api.reference.langfuse.com/
 */

export interface TraceCreateBody {
	id: string;
	name?: string;
	userId?: string;
	sessionId?: string;
	metadata?: Record<string, unknown>;
	tags?: string[];
	input?: unknown;
	output?: unknown;
	timestamp?: string;
	release?: string;
	version?: string;
	public?: boolean;
}

export interface GenerationCreateBody {
	id: string;
	traceId: string;
	name?: string;
	parentObservationId?: string;
	model?: string;
	modelParameters?: Record<string, unknown>;
	input?: unknown;
	output?: unknown;
	usage?: { input?: number; output?: number; total?: number; unit?: string };
	startTime?: string;
	endTime?: string;
	completionStartTime?: string;
	metadata?: Record<string, unknown>;
	level?: "DEBUG" | "DEFAULT" | "WARNING" | "ERROR";
	statusMessage?: string;
}

export interface ScoreCreateBody {
	id: string;
	traceId: string;
	observationId?: string;
	name: string;
	value: number | string;
	comment?: string;
	dataType?: "NUMERIC" | "CATEGORICAL" | "BOOLEAN";
}

export type IngestionEvent =
	| { id: string; timestamp: string; type: "trace-create"; body: TraceCreateBody }
	| { id: string; timestamp: string; type: "generation-create"; body: GenerationCreateBody }
	| { id: string; timestamp: string; type: "score-create"; body: ScoreCreateBody };

export interface LangfusePrompt {
	id: string;
	name: string;
	version: number;
	prompt: string | unknown[];
	config?: Record<string, unknown>;
	tags?: string[];
	type?: "text" | "chat";
	labels?: string[];
}

export interface LangfuseDatasetItem {
	id: string;
	datasetId: string;
	input?: unknown;
	expectedOutput?: unknown;
	metadata?: Record<string, unknown>;
}
