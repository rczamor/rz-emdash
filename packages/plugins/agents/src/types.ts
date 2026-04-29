/**
 * Agent registry types.
 *
 * An Agent is the runtime instance of an identity. It maps the
 * polymorphic Task assignee namespace ("agent:<id>") to a concrete
 * configuration: which model to call, what skills to draw from, what
 * tools to allow, what voice/persona to wear, what quotas apply.
 *
 * Identity-as-files split borrowed from OpenClaw:
 *   identity   — role, responsibilities, decision framework (IDENTITY.md)
 *   soul       — values, voice, opinions (SOUL.md)
 *   tools_md   — environment-specific notes (TOOLS.md)
 *
 * Skills are references to a content collection (default: agent_skills).
 * Tools are references to a tool registry (the Tools plugin or
 * emdash MCP tools).
 */

export interface AgentModel {
	primary: string;
	fallback?: string;
	temperature?: number;
	maxTokens?: number;
}

export interface AgentQuotas {
	/** Tokens-per-day cap. Overrides tasks plugin default. 0 = unlimited. */
	dailyTokens?: number;
	/** Tokens-per-task cap. Overrides tasks plugin default. 0 = unlimited. */
	taskTokens?: number;
	/** Max LLM calls per day. 0 = unlimited. */
	dailyCalls?: number;
}

export interface Agent {
	id: string;
	name: string;
	role: string;
	active: boolean;

	identity: string;
	soul?: string;
	tools_md?: string;

	model: AgentModel;

	/** Slugs of skill content items in the configured skills collection. */
	skills: string[];
	/** Tool names from the tools registry (or MCP catalog). */
	tools: string[];

	/** Collection that holds agent skills. Defaults to "agent_skills". */
	skills_collection?: string;

	/**
	 * If true, every skill body is concatenated into the system prompt at
	 * compile time (legacy behavior). If false (default after M8), only a
	 * skill index is inlined and the agent loads bodies on demand via the
	 * `skill_load` tool. Use when skills are short or the agent has fewer
	 * than ~10 of them.
	 */
	bulk_load_skills?: boolean;

	quotas?: AgentQuotas;

	created_at: string;
	updated_at: string;
}

export interface CreateAgentInput {
	id: string;
	name: string;
	role: string;
	active?: boolean;
	identity: string;
	soul?: string;
	tools_md?: string;
	model: AgentModel;
	skills?: string[];
	tools?: string[];
	skills_collection?: string;
	quotas?: AgentQuotas;
}

export interface UpdateAgentInput {
	id: string;
	name?: string;
	role?: string;
	active?: boolean;
	identity?: string;
	soul?: string;
	tools_md?: string;
	model?: Partial<AgentModel>;
	skills?: string[];
	tools?: string[];
	skills_collection?: string;
	quotas?: AgentQuotas;
}

/**
 * Memory entry — partitioned by agent_id. High write frequency, so it
 * lives in the DB rather than markdown files. Source-tracked so an
 * agent can cite where a memory came from.
 */
export interface MemoryEntry {
	id: string;
	agent_id: string;
	key: string;
	value: unknown;
	importance: number;
	source?: string;
	tags?: string[];
	last_accessed_at: string;
	created_at: string;
}

export interface MemoryPutInput {
	agent_id: string;
	key: string;
	value: unknown;
	importance?: number;
	source?: string;
	tags?: string[];
}

export interface MemorySearchInput {
	agent_id: string;
	query?: string;
	tags?: string[];
	importance_min?: number;
	limit?: number;
}

/**
 * Compiled agent context — what the OpenRouter / Automations engine
 * needs to build a system prompt for an agent's run.
 */
export interface CompiledAgentContext {
	agent: Agent;
	/**
	 * Skill records. When `agent.bulk_load_skills === true`, this array
	 * contains full bodies. Otherwise it contains only summaries (first
	 * paragraph) and the agent uses `skill_load` to fetch bodies on
	 * demand. The shape is the same either way; consumers can detect
	 * progressive-disclosure mode by `body.length` vs `summary.length`
	 * or by reading `agent.bulk_load_skills`.
	 */
	skills: Array<{ slug: string; name: string; body: string; summary?: string }>;
	memories: MemoryEntry[];
}
