import { requestUrl, RequestUrlResponse } from "obsidian";

const BASE = "https://tasks.googleapis.com/tasks/v1";
const MIN_INTERVAL_MS = 120;
const MAX_RETRIES = 5;

export interface GoogleTaskList {
	id: string;
	title: string;
	updated: string;
}

export interface GoogleTask {
	id: string;
	title?: string;
	notes?: string;
	due?: string;
	status?: "needsAction" | "completed";
	completed?: string;
	parent?: string;
	position?: string;
	updated: string;
	deleted?: boolean;
	hidden?: boolean;
}

export interface TaskWrite {
	title?: string;
	notes?: string | null;
	due?: string | null;
	status?: "needsAction" | "completed";
	completed?: string | null;
}

interface Page<T> {
	items?: T[];
	nextPageToken?: string;
}

export class ApiError extends Error {
	constructor(message: string, readonly status: number) {
		super(message);
	}
}

/** Thrown when the request never reached Google (offline, DNS, etc.). */
export class NetworkError extends Error {}

export type TokenProvider = () => Promise<string>;

export interface ListTasksOptions {
	updatedMin?: string;
	completedMin?: string;
	showCompleted?: boolean;
	showHidden?: boolean;
	showDeleted?: boolean;
}

function sleep(ms: number): Promise<void> {
	return new Promise((r) => window.setTimeout(r, ms));
}

/** Thin typed wrapper around Google Tasks API v1 with throttling, retries and pagination. */
export class TasksApi {
	private lastRequest = 0;
	private queue: Promise<unknown> = Promise.resolve();

	constructor(private readonly token: TokenProvider) {}

	private async throttle(): Promise<void> {
		const wait = this.lastRequest + MIN_INTERVAL_MS - Date.now();
		if (wait > 0) await sleep(wait);
		this.lastRequest = Date.now();
	}

	private request<T>(method: string, path: string, query?: Record<string, string | undefined>, body?: unknown): Promise<T> {
		// Serialize requests so throttling is effective.
		const run = this.queue.then(() => this.doRequest<T>(method, path, query, body));
		this.queue = run.catch(() => undefined);
		return run;
	}

	private async doRequest<T>(method: string, path: string, query?: Record<string, string | undefined>, body?: unknown): Promise<T> {
		const qs = new URLSearchParams();
		if (query) for (const [k, v] of Object.entries(query)) if (v !== undefined) qs.set(k, v);
		const url = `${BASE}${path}${qs.toString() ? `?${qs.toString()}` : ""}`;

		for (let attempt = 0; ; attempt++) {
			await this.throttle();
			const token = await this.token();
			let res: RequestUrlResponse;
			try {
				res = await requestUrl({
					url,
					method,
					headers: { Authorization: `Bearer ${token}` },
					contentType: body !== undefined ? "application/json" : undefined,
					body: body !== undefined ? JSON.stringify(body) : undefined,
					throw: false,
				});
			} catch (e) {
				throw new NetworkError(e instanceof Error ? e.message : String(e));
			}

			if (res.status === 429 || res.status >= 500 || (res.status === 403 && /rate|quota/i.test(res.text))) {
				if (attempt >= MAX_RETRIES) throw new ApiError(`Google API busy (HTTP ${res.status})`, res.status);
				const retryAfter = Number(res.headers["retry-after"] ?? res.headers["Retry-After"]);
				const delay = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : Math.min(32000, 1000 * 2 ** attempt) + Math.random() * 500;
				await sleep(delay);
				continue;
			}
			if (res.status >= 400) {
				let msg = `HTTP ${res.status}`;
				try {
					const j = res.json as { error?: { message?: string } };
					if (j.error?.message) msg = j.error.message;
				} catch {
					/* ignore */
				}
				throw new ApiError(msg, res.status);
			}
			if (res.status === 204 || !res.text) return undefined as T;
			return res.json as T;
		}
	}

	private async paginate<T>(path: string, query: Record<string, string | undefined>): Promise<T[]> {
		const out: T[] = [];
		let pageToken: string | undefined;
		do {
			const page = await this.request<Page<T>>("GET", path, { ...query, pageToken });
			if (page.items) out.push(...page.items);
			pageToken = page.nextPageToken;
		} while (pageToken);
		return out;
	}

	listTaskLists(): Promise<GoogleTaskList[]> {
		return this.paginate<GoogleTaskList>("/users/@me/lists", { maxResults: "100" });
	}

	listTasks(listId: string, opts: ListTasksOptions): Promise<GoogleTask[]> {
		return this.paginate<GoogleTask>(`/lists/${encodeURIComponent(listId)}/tasks`, {
			maxResults: "100",
			showCompleted: String(opts.showCompleted ?? true),
			showHidden: String(opts.showHidden ?? true),
			showDeleted: String(opts.showDeleted ?? false),
			updatedMin: opts.updatedMin,
			completedMin: opts.completedMin,
		});
	}

	insertTask(listId: string, task: TaskWrite, parent?: string): Promise<GoogleTask> {
		return this.request<GoogleTask>("POST", `/lists/${encodeURIComponent(listId)}/tasks`, { parent }, task);
	}

	patchTask(listId: string, taskId: string, task: TaskWrite): Promise<GoogleTask> {
		return this.request<GoogleTask>("PATCH", `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`, undefined, task);
	}

	deleteTask(listId: string, taskId: string): Promise<void> {
		return this.request<void>("DELETE", `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}`);
	}

	moveTask(listId: string, taskId: string, opts: { parent?: string; destinationTasklist?: string }): Promise<GoogleTask> {
		return this.request<GoogleTask>("POST", `/lists/${encodeURIComponent(listId)}/tasks/${encodeURIComponent(taskId)}/move`, {
			parent: opts.parent,
			destinationTasklist: opts.destinationTasklist,
		});
	}
}
