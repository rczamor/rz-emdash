/**
 * Brand types — voice / tone / vocabulary as structured content.
 *
 * A Brand record captures editorial guidelines: positioning, voice
 * attributes, do/don't phrases, vocabulary preferences. Different
 * from DESIGN.md (visual identity) and from skills (agent
 * capabilities).
 *
 * Stored in plugin storage so the editorial team has versioning,
 * review workflow, and the option of multi-language variants
 * without coupling to a specific content collection schema.
 */

export interface VoiceAttribute {
	name: string;
	intensity?: number;
	description?: string;
}

export interface ToneRule {
	context: string;
	guidance: string;
}

export interface PhraseExample {
	good: string;
	bad?: string;
	rationale?: string;
}

export interface VocabEntry {
	preferred: string;
	avoid?: string[];
	rationale?: string;
}

export interface Brand {
	id: string;
	locale?: string;
	name: string;
	positioning: string;
	voice_attributes: VoiceAttribute[];
	tone_rules: ToneRule[];
	vocabulary: VocabEntry[];
	banned_phrases: string[];
	examples: PhraseExample[];
	notes?: string;
	active: boolean;
	created_at: string;
	updated_at: string;
}

export interface CreateBrandInput {
	id: string;
	locale?: string;
	name: string;
	positioning: string;
	voice_attributes?: VoiceAttribute[];
	tone_rules?: ToneRule[];
	vocabulary?: VocabEntry[];
	banned_phrases?: string[];
	examples?: PhraseExample[];
	notes?: string;
	active?: boolean;
}

export interface UpdateBrandInput {
	id: string;
	locale?: string;
	name?: string;
	positioning?: string;
	voice_attributes?: VoiceAttribute[];
	tone_rules?: ToneRule[];
	vocabulary?: VocabEntry[];
	banned_phrases?: string[];
	examples?: PhraseExample[];
	notes?: string;
	active?: boolean;
}
