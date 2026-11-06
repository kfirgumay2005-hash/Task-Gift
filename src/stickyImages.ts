import { App, normalizePath, TFile } from "obsidian";

/** Folder (next to the data note) for pictures on the sticky-note board when the setting asks for the plugin's folder. */
export const STICKY_IMAGES_FOLDER = "Sticky images";
export const IMAGE_EXTENSIONS = ["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif"];

export function stickyImagesFolderFor(dataPath: string): string {
	const slash = dataPath.lastIndexOf("/");
	return slash === -1 ? STICKY_IMAGES_FOLDER : `${dataPath.slice(0, slash)}/${STICKY_IMAGES_FOLDER}`;
}

/** Whether a dropped / pasted file is a picture. */
export function isImageFile(file: File): boolean {
	return file.type.startsWith("image/") || IMAGE_EXTENSIONS.includes(extensionOf(file.name));
}

export function imageFiles(list: FileList | null | undefined): File[] {
	return Array.from(list ?? []).filter(isImageFile);
}

function extensionOf(name: string): string {
	const dot = name.lastIndexOf(".");
	return dot === -1 ? "" : name.slice(dot + 1).toLowerCase();
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * Copies a picture into the vault and resolves with its path: into `folder`, or with `folder` null into Obsidian's
 * attachment folder (Settings → Files and links).
 */
export async function saveStickyImage(app: App, folder: string | null, file: File): Promise<string> {
	let ext = extensionOf(file.name);
	if (!IMAGE_EXTENSIONS.includes(ext)) ext = (file.type.split("/")[1] ?? "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
	// Pasted pictures are all called "image.png": name them by the time instead.
	const d = new Date();
	const stamp = `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
	const given = file.name.replace(/\.[^.]*$/, "").replace(/[\\/:*?"<>|#^[\]]/g, "").trim();
	const base = !given || given === "image" ? `Image ${stamp}` : given;
	let path: string;
	if (folder === null) {
		// Obsidian picks the folder and a free name; a relative ("./…") folder is taken from the vault root.
		path = await app.fileManager.getAvailablePathForAttachment(`${base}.${ext}`, "");
		folder = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
	} else {
		folder = normalizePath(folder);
		path = normalizePath(`${folder}/${base}.${ext}`);
		for (let i = 1; app.vault.getAbstractFileByPath(path); i++) path = normalizePath(`${folder}/${base} ${i}.${ext}`);
	}
	if (folder && !app.vault.getAbstractFileByPath(folder)) await app.vault.createFolder(folder);
	await app.vault.createBinary(path, await file.arrayBuffer());
	return path;
}

/** Natural size of a picture file, or null if it can't be read. */
export function imageSize(file: File): Promise<{ w: number; h: number } | null> {
	return new Promise((resolve) => {
		const url = URL.createObjectURL(file);
		const img = new Image();
		img.onload = () => {
			URL.revokeObjectURL(url);
			resolve(img.naturalWidth && img.naturalHeight ? { w: img.naturalWidth, h: img.naturalHeight } : null);
		};
		img.onerror = () => {
			URL.revokeObjectURL(url);
			resolve(null);
		};
		img.src = url;
	});
}

export function imageFile(app: App, path: string): TFile | null {
	const f = app.vault.getAbstractFileByPath(path);
	return f instanceof TFile ? f : null;
}
