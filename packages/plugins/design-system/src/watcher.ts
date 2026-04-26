/**
 * Filesystem auto-watcher for DESIGN.md.
 *
 * Trusted-mode helper. Uses Node's built-in `fs.watch` (no extra
 * deps) and a debounced re-parse callback. The plugin's runtime
 * entrypoint instantiates one `DesignWatcher` and lets it own the
 * lifecycle for the process.
 *
 * Sandbox-mode incompatible (no Node fs APIs in V8 isolates). The
 * plugin gracefully no-ops when fs is unavailable.
 *
 * The default candidate paths are:
 *   $DESIGN_MD_PATH (env var override, takes priority)
 *   ./DESIGN.md
 *   ./design.md
 *   /app/DESIGN.md            (Docker deploy convention)
 *   /app/design.md
 *
 * The first existing path wins. If none exist on boot, the watcher
 * polls every 30s for one to appear (cheap, lets you `cp` the file
 * in after deploy without restarting).
 */

import { existsSync, readFileSync, watch as fsWatch, type FSWatcher } from "node:fs";
import { join } from "node:path";

const DEBOUNCE_MS = 250;
const POLL_INTERVAL_MS = 30_000;

export interface WatcherOptions {
	candidatePaths?: string[];
	onChange?: (source: string, path: string) => Promise<void> | void;
	onError?: (error: Error) => void;
}

export class DesignWatcher {
	private watcher: FSWatcher | null = null;
	private currentPath: string | null = null;
	private debounceTimer: ReturnType<typeof setTimeout> | null = null;
	private pollTimer: ReturnType<typeof setTimeout> | null = null;
	private stopped = false;

	constructor(private readonly options: WatcherOptions = {}) {}

	candidatePaths(): string[] {
		if (this.options.candidatePaths) return this.options.candidatePaths;
		const env = process.env.DESIGN_MD_PATH;
		const cwd = process.cwd();
		const list = env ? [env] : [];
		list.push(
			join(cwd, "DESIGN.md"),
			join(cwd, "design.md"),
			"/app/DESIGN.md",
			"/app/design.md",
		);
		return list;
	}

	currentSource(): { path: string; source: string } | null {
		for (const path of this.candidatePaths()) {
			try {
				if (existsSync(path)) {
					return { path, source: readFileSync(path, "utf8") };
				}
			} catch {
				/* skip */
			}
		}
		return null;
	}

	start(): void {
		if (this.stopped) return;
		const found = this.currentSource();
		if (found) {
			this.attachWatcher(found.path);
			void this.fireChange(found.source, found.path);
		} else {
			this.schedulePoll();
		}
	}

	stop(): void {
		this.stopped = true;
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		if (this.debounceTimer) {
			clearTimeout(this.debounceTimer);
			this.debounceTimer = null;
		}
		if (this.pollTimer) {
			clearTimeout(this.pollTimer);
			this.pollTimer = null;
		}
	}

	/** Force a re-read + parse of the currently-watched file. */
	async reload(): Promise<{ ok: boolean; path?: string; error?: string }> {
		const found = this.currentSource();
		if (!found) return { ok: false, error: "DESIGN.md not found at any candidate path" };
		await this.fireChange(found.source, found.path);
		return { ok: true, path: found.path };
	}

	private attachWatcher(path: string): void {
		if (this.currentPath === path && this.watcher) return;
		if (this.watcher) {
			this.watcher.close();
			this.watcher = null;
		}
		try {
			this.watcher = fsWatch(path, { persistent: false }, (event) => {
				if (this.stopped) return;
				if (event !== "change" && event !== "rename") return;
				this.scheduleDebouncedReparse();
			});
			this.currentPath = path;
		} catch (err) {
			this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
		}
	}

	private scheduleDebouncedReparse(): void {
		if (this.debounceTimer) clearTimeout(this.debounceTimer);
		this.debounceTimer = setTimeout(() => {
			this.debounceTimer = null;
			if (this.stopped) return;
			const found = this.currentSource();
			if (!found) {
				// File got deleted/renamed — drop the watcher and re-poll.
				if (this.watcher) {
					this.watcher.close();
					this.watcher = null;
					this.currentPath = null;
				}
				this.schedulePoll();
				return;
			}
			if (found.path !== this.currentPath) {
				this.attachWatcher(found.path);
			}
			void this.fireChange(found.source, found.path);
		}, DEBOUNCE_MS);
	}

	private schedulePoll(): void {
		if (this.pollTimer || this.stopped) return;
		this.pollTimer = setTimeout(() => {
			this.pollTimer = null;
			if (this.stopped) return;
			const found = this.currentSource();
			if (found) {
				this.attachWatcher(found.path);
				void this.fireChange(found.source, found.path);
			} else {
				this.schedulePoll();
			}
		}, POLL_INTERVAL_MS);
	}

	private async fireChange(source: string, path: string): Promise<void> {
		try {
			await this.options.onChange?.(source, path);
		} catch (err) {
			this.options.onError?.(err instanceof Error ? err : new Error(String(err)));
		}
	}
}
