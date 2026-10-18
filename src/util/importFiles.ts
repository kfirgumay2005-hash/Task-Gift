import { App, Notice } from "obsidian";

/** Opens the system file picker (computer or phone) and resolves with the chosen files (none if cancelled). */
function pickFiles(extensions: string[], multiple: boolean): Promise<File[]> {
	return new Promise((resolve) => {
		// The input has to be in the document: a detached one may never open or report the selection (notably on mobile).
		const input = activeDocument.body.createEl("input", {
			cls: "tg-hidden-file-input",
			attr: { type: "file", accept: extensions.map((e) => `.${e}`).join(",") },
		});
		input.multiple = multiple;
		input.addEventListener("change", () => {
			const files = Array.from(input.files ?? []);
			input.remove();
			resolve(files);
		});
		input.addEventListener("cancel", () => {
			input.remove();
			resolve([]);
		});
		input.click();
	});
}

/**
 * Lets the user pick files from this device, copies them into the vault's attachments folder
 * and resolves with their vault paths.
 */
export async function importFiles(app: App, extensions: string[], multiple: boolean): Promise<string[]> {
	const files = await pickFiles(extensions, multiple);
	const paths: string[] = [];
	for (const file of files) {
		try {
			// Respects Obsidian's "Default location for new attachments" setting.
			const path = await app.fileManager.getAvailablePathForAttachment(file.name);
			await app.vault.createBinary(path, await file.arrayBuffer());
			paths.push(path);
		} catch (e) {
			new Notice(`Could not import "${file.name}": ${e instanceof Error ? e.message : String(e)}`);
		}
	}
	if (paths.length) new Notice(paths.length === 1 ? `Imported: ${paths[0]}` : `Imported ${paths.length} files`);
	return paths;
}
