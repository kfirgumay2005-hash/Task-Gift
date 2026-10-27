import { App, FuzzyMatch, FuzzySuggestModal } from "obsidian";
import { allCommands, ObsidianCommand, stickyEditFor } from "../stickyCommands";

/** Picks any Obsidian command, like the command palette. */
export class CommandSuggestModal extends FuzzySuggestModal<ObsidianCommand> {
	constructor(
		app: App,
		private readonly onPick: (cmd: ObsidianCommand) => void,
	) {
		super(app);
		this.setPlaceholder("Pick a command for the sticky note menu…");
	}

	getItems(): ObsidianCommand[] {
		return allCommands(this.app);
	}

	getItemText(cmd: ObsidianCommand): string {
		return cmd.name;
	}

	renderSuggestion(match: FuzzyMatch<ObsidianCommand>, el: HTMLElement): void {
		super.renderSuggestion(match, el);
		if (stickyEditFor(match.item.id)) el.createDiv({ cls: "tg-command-note", text: "Formats the sticky note's text" });
	}

	onChooseItem(cmd: ObsidianCommand): void {
		this.onPick(cmd);
	}
}
