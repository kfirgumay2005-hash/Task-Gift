import { App, Modal, Notice, Platform, setIcon } from "obsidian";
import {
	AuthSession,
	catchRedirect,
	checkCredentials,
	createAuthSession,
	exchangeCode,
	MANUAL_REDIRECT_URI,
	openInBrowser,
	parsePastedCode,
} from "../auth/oauth";
import type { AuthData } from "../types";

/**
 * Copy-paste sign-in that works on every platform, including iOS and Android:
 * Google redirects to a loopback address nothing listens on, so the browser shows
 * a "can't connect" page whose address contains the code. The user pastes it here.
 */
export class LoginModal extends Modal {
	private session: AuthSession | null = null;
	private busy = false;
	private listener: AbortController | null = null;
	private connectBtn: HTMLButtonElement | null = null;

	constructor(
		app: App,
		private readonly clientId: string,
		private readonly clientSecret: string,
		private readonly onSuccess: (auth: AuthData) => Promise<void>,
	) {
		super(app);
	}

	onOpen(): void {
		const { contentEl } = this;
		this.modalEl.addClass("tg-login-modal");
		this.setTitle("Connect Google account");
		try {
			checkCredentials(this.clientId, this.clientSecret);
		} catch (e) {
			contentEl.createEl("p", { text: (e as Error).message });
			return;
		}

		const steps = contentEl.createEl("ol", { cls: "tg-login-steps" });
		const s1 = steps.createEl("li");
		s1.createDiv({ text: "Open the Google sign-in page and approve access." });
		const openBtn = s1.createEl("button", { cls: "mod-cta tg-login-open" });
		setIcon(openBtn.createSpan(), "external-link");
		openBtn.createSpan({ text: "Open Google sign-in" });
		openBtn.addEventListener("click", () => void this.openSignIn());

		const s2 = steps.createEl("li");
		s2.createDiv({
			text: `After approving, the browser goes to a page that can't load ("This site can't be reached"). That's expected. Copy the full address from the address bar. It starts with ${MANUAL_REDIRECT_URI}.`,
		});

		const s3 = steps.createEl("li");
		s3.createDiv({ text: "Paste it here:" });
		const input = s3.createEl("textarea", {
			cls: "tg-input tg-login-input",
			attr: { rows: "3", placeholder: `${MANUAL_REDIRECT_URI}/?state=…&code=…`, autocapitalize: "off", autocorrect: "off", spellcheck: "false" },
		});

		const buttons = contentEl.createDiv({ cls: "tg-modal-buttons" });
		if (Platform.isDesktopApp) {
			buttons.createDiv({ cls: "tg-subhint", text: "On desktop the address is usually picked up automatically after you approve." });
		}
		buttons.createDiv({ cls: "tg-spacer" });
		buttons.createEl("button", { text: "Cancel" }).addEventListener("click", () => this.close());
		const connect = buttons.createEl("button", { text: "Connect", cls: "mod-cta" });
		this.connectBtn = connect;
		connect.addEventListener("click", () => void this.finish(input.value, connect));
	}

	private async openSignIn(): Promise<void> {
		this.listener?.abort();
		const session = await createAuthSession(this.clientId, MANUAL_REDIRECT_URI);
		this.session = session;
		if (Platform.isDesktopApp) {
			// Catch the redirect automatically; if the port is busy, pasting still works.
			const ctrl = new AbortController();
			this.listener = ctrl;
			catchRedirect(Number(new URL(MANUAL_REDIRECT_URI).port), session.state, ctrl.signal)
				.then((code) => {
					if (this.session === session && this.connectBtn) void this.finish("", this.connectBtn, code);
				})
				.catch((e) => {
					if (!ctrl.signal.aborted) console.info("[Task Gift] Automatic pickup unavailable, paste the address instead:", e);
				});
		}
		openInBrowser(session.url);
	}

	private async finish(pasted: string, btn: HTMLButtonElement, caughtCode?: string): Promise<void> {
		if (this.busy) return;
		if (!this.session) {
			new Notice("Open the Google sign-in page first (step 1).");
			return;
		}
		this.busy = true;
		btn.disabled = true;
		btn.setText("Connecting…");
		try {
			const code = caughtCode ?? parsePastedCode(pasted, this.session);
			const auth = await exchangeCode(this.session, code, this.clientId, this.clientSecret);
			this.close();
			await this.onSuccess(auth);
		} catch (e) {
			new Notice(`Google connection failed: ${e instanceof Error ? e.message : String(e)}`, 8000);
			btn.disabled = false;
			btn.setText("Connect");
		} finally {
			this.busy = false;
		}
	}

	onClose(): void {
		this.listener?.abort();
		this.contentEl.empty();
	}
}
