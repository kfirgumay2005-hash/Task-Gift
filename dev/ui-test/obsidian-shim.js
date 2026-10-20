// Stand-in for the "obsidian" module in the browser test page: just enough DOM helpers, Modal and Setting.
// Keep Modal's instance fields in step with the real one (see CLAUDE.md), or name clashes stay hidden here.
const P = HTMLElement.prototype;
function make(tag, o, parent) {
	const el = document.createElement(tag);
	if (typeof o === "string") o = { cls: o };
	o = o || {};
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text != null) el.textContent = o.text;
	if (o.attr) for (const [k, v] of Object.entries(o.attr)) el.setAttribute(k, v);
	parent.appendChild(el);
	return el;
}
P.createDiv = function (o) { return make("div", o, this); };
P.createSpan = function (o) { return make("span", o, this); };
P.createEl = function (t, o) { return make(t, o, this); };
P.empty = function () { while (this.firstChild) this.removeChild(this.firstChild); };
P.appendText = function (t) { this.appendChild(document.createTextNode(t)); };
P.setText = function (t) { this.textContent = t; };
P.addClass = function (c) { this.classList.add(c); };
P.toggleClass = function (c, b) { this.classList.toggle(c, b); };
Object.defineProperty(Node.prototype, "doc", { get() { return this.ownerDocument; } });
Object.defineProperty(Node.prototype, "win", { get() { return this.ownerDocument.defaultView; } });
window.activeDocument = document;
window.activeWindow = window;

export function setIcon(el) { el.textContent = "Ø"; }

export class Modal {
	constructor(app) {
		// The real Modal's own instance fields (Obsidian 1.14, not in obsidian.d.ts).
		Object.assign(this, { app, selection: null, win: null, scope: {}, isOpen: false, shouldRestoreSelection: true, shouldAnimateOpen: true, hasInitialInputFocus: true, dimBackground: true, bgOpacity: "0.85", headerEl: null, bgEl: null, titleEl: null, onWindowClose: () => {} });
		this.containerEl = document.body.createDiv("modal-container");
		this.modalEl = this.containerEl.createDiv("modal");
		this.titleEl = this.modalEl.createDiv("modal-title");
		this.contentEl = this.modalEl.createDiv("modal-content");
	}
	setTitle(t) { this.titleEl.textContent = t; return this; }
	open() { this.isOpen = true; this.selection = { saved: true }; this.onOpen(); }
	close() { this.isOpen = false; this.onClose(); this.containerEl.remove(); }
	onOpen() {}
	onClose() {}
}

export class Setting {
	constructor(parent) {
		this.settingEl = parent.createDiv("setting-item");
		const info = this.settingEl.createDiv("setting-item-info");
		this.nameEl = info.createDiv("setting-item-name");
		this.descEl = info.createDiv("setting-item-description");
		this.controlEl = this.settingEl.createDiv("setting-item-control");
	}
	setName(n) { this.nameEl.textContent = n; return this; }
	setDesc(d) { this.descEl.textContent = d; return this; }
	addDropdown(cb) {
		const s = this.controlEl.createEl("select", "dropdown");
		const d = { selectEl: s, addOption: (k, l) => { s.createEl("option", { text: l, attr: { value: k } }); return d; }, setValue: (v) => { s.value = v; return d; }, onChange: (f) => { s.onchange = () => f(s.value); return d; } };
		cb(d);
		return this;
	}
	addToggle(cb) {
		const i = this.controlEl.createEl("input", { attr: { type: "checkbox" } });
		const t = { setValue: (v) => { i.checked = v; return t; }, onChange: (f) => { i.onchange = () => f(i.checked); return t; } };
		cb(t);
		return this;
	}
}
