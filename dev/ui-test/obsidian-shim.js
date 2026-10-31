// Stand-in for the "obsidian" module in the browser test page: just enough DOM helpers, Modal and Setting.
// Keep Modal's instance fields in step with the real one (see CLAUDE.md), or name clashes stay hidden here.
const P = HTMLElement.prototype;
function make(tag, o, parent) {
	const el = document.createElement(tag);
	if (typeof o === "string") o = { cls: o };
	o = o || {};
	if (o.cls) el.className = Array.isArray(o.cls) ? o.cls.join(" ") : o.cls;
	if (o.text != null) el.textContent = o.text;
	if (o.value != null) el.value = o.value;
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
P.removeClass = function (c) { this.classList.remove(c); };
P.toggleClass = function (c, b) { this.classList.toggle(c, b); };
P.hasClass = function (c) { return this.classList.contains(c); };
P.setAttr = function (k, v) { this.setAttribute(k, v); };
Object.defineProperty(Node.prototype, "doc", { get() { return this.ownerDocument; } });
Object.defineProperty(Node.prototype, "win", { get() { return this.ownerDocument.defaultView; } });
window.activeDocument = document;
window.activeWindow = window;

export function setIcon(el) { el.textContent = "Ø"; }
export function getIcon() { return document.createElement("span"); }
export const Platform = { isMobile: false, isDesktop: true };
export class TFile {}
export const normalizePath = (p) => p;
export class Notice { constructor(msg) { (window.notices ??= []).push(msg); } }
class MenuItem {
	setTitle(t) { this.title = t; return this; }
	setIcon() { return this; }
	setChecked(c) { this.checked = c; return this; }
	setSection(s) { this.section = s; return this; }
	setWarning(w) { this.warning = w; return this; }
	onClick(f) { this.click = f; return this; }
}
/** Records its items; the test picks one with `window.lastMenu.find((i) => i.title === "…").click()`. */
export class Menu {
	items = [];
	addItem(cb) { const i = new MenuItem(); cb(i); this.items.push(i); return this; }
	addSeparator() { return this; }
	showAtMouseEvent() { window.lastMenu = this.items; }
}
/** Parent/child loading only; children are unloaded with their parent or when removed. */
export class Component {
	_children = [];
	_loaded = false;
	load() { this._loaded = true; this._children.forEach((c) => c.load()); }
	unload() { this._children.forEach((c) => c.unload()); this._loaded = false; }
	addChild(c) { this._children.push(c); if (this._loaded) c.load(); return c; }
	removeChild(c) { const i = this._children.indexOf(c); if (i >= 0) { this._children.splice(i, 1); c.unload(); } return c; }
}
/** Tiny Markdown stand-in: bold, highlight and raw <u> only. */
export const MarkdownRenderer = {
	render: async (app, md, el) => {
		const esc = md.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
		el.createEl("p").innerHTML = esc.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>").replace(/==(.+?)==/g, "<mark>$1</mark>").replace(/&lt;u&gt;(.+?)&lt;\/u&gt;/g, "<u>$1</u>");
	},
};

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
	addText(cb) {
		const i = this.controlEl.createEl("input", { attr: { type: "text" } });
		const t = { inputEl: i, setPlaceholder: (p) => { i.placeholder = p; return t; }, setValue: (v) => { i.value = v; return t; }, onChange: (f) => { i.oninput = () => f(i.value); return t; } };
		cb(t);
		return this;
	}
	addToggle(cb) {
		const i = this.controlEl.createEl("input", { attr: { type: "checkbox" } });
		const t = { setValue: (v) => { i.checked = v; return t; }, onChange: (f) => { i.onchange = () => f(i.checked); return t; } };
		cb(t);
		return this;
	}
}
