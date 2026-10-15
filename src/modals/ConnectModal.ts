import { App, Modal, setIcon } from "obsidian";
import { AuthError, login, openInBrowser } from "../auth/oauth";
import type { AuthData } from "../types";

/**
 * Desktop automatic sign-in with visible progress: shows that we're waiting for the browser,
 * and offers "open again", "manual sign-in" and "cancel" instead of a silent wait.
 */
export class ConnectModal extends Modal {
	private controller = new AbortController();
	private url: string | null = null;
	private finished = false;

	constructor(
		app: App,
		private readonly clientId: string,
		private readonly clientSecret: string,
		private readonly onSuccess: (auth: AuthData) => Promise<void>,
		private readonly onManual: () => void,
	) {
		super(app);
	}

	onOpen(): void {
		this.setTitle("Connecting to Google");
		const { contentEl } = this;
		const status = contentEl.createDiv({ cls: "tg-connect-status" });
		status.createDiv({ cls: "tg-spinner" });
		const text = status.createDiv();
		text.createDiv({ cls: "tg-connect-title", text: "Waiting for you in the browser…" });
		text.createDiv({
			cls: "tg-subhint",
			text: "Choose your Google account and allow access. This window closes by itself when you're done.",
		});

		const help = contentEl.createDiv({ cls: "tg-hint" });
		setIcon(help.createSpan({ cls: "tg-hint-icon" }), "info");
		help.createSpan({
			text: "Seeing \"Access blocked\" or \"Error 403: access_denied\"? Add your Google account as a Test user in Google Cloud (OAuth consent screen → Audience), or publish the app.",
		});

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		buttons.createEl("button", { text: "Open the page again" }).addEventListener("click", () => {
			if (this.url) openInBrowser(this.url);
		});
		buttons.createEl("button", { text: "Manual sign-in" }).addEventListener("click", () => {
			this.close();
			this.onManual();
		});
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());

		void this.run(text);
	}

	private async run(text: HTMLElement): Promise<void> {
		try {
			const auth = await login(this.clientId, this.clientSecret, {
				signal: this.controller.signal,
				onUrl: (u) => (this.url = u),
			});
			this.finished = true;
			text.empty();
			text.createDiv({ cls: "tg-connect-title", text: "Connected. Syncing your tasks…" });
			await this.onSuccess(auth);
			this.close();
		} catch (e) {
			if (this.controller.signal.aborted) return;
			this.finished = true;
			text.empty();
			text.createDiv({ cls: "tg-connect-title mod-warning", text: "Could not connect" });
			text.createDiv({ cls: "tg-subhint", text: e instanceof AuthError || e instanceof Error ? e.message : String(e) });
			this.contentEl.querySelector(".tg-spinner")?.remove();
		}
	}

	onClose(): void {
		if (!this.finished) this.controller.abort();
		this.contentEl.empty();
	}
}
