import {
	App,
	Editor,
	EditorPosition,
	Notice,
	Plugin,
	PluginSettingTab,
	Setting
} from "obsidian";

interface MathInlineBlockToggleSettings {
	showInContextMenu: boolean;
	trimSurroundingWhitespace: boolean;
}

interface EditorRange {
	from: EditorPosition;
	to: EditorPosition;
}

interface OffsetRange {
	start: number;
	end: number; // Exclusive
}

interface InlineLineRange {
	start: number;
	end: number; // Exclusive
}

const DEFAULT_SETTINGS: MathInlineBlockToggleSettings = {
	showInContextMenu: true,
	trimSurroundingWhitespace: true
};

function isEscaped(text: string, index: number): boolean {
	let backslashCount = 0;
	for (let i = index - 1; i >= 0 && text[i] === "\\"; i--) {
		backslashCount++;
	}
	return backslashCount % 2 === 1;
}

function isLikelyInlineOpeningDelimiter(line: string, index: number): boolean {
	if (index + 1 >= line.length) {
		return false;
	}

	const next = line[index + 1];
	if (next === "$" || /\s/.test(next)) {
		return false;
	}

	// Heuristic to avoid common currency patterns like "$20".
	const isDigit = next >= "0" && next <= "9";
	if (isDigit) {
		const prev = index > 0 ? line[index - 1] : " ";
		if (index === 0 || /\s/.test(prev)) {
			return false;
		}
	}

	return true;
}

function isLikelyInlineClosingDelimiter(line: string, index: number): boolean {
	if (index === 0) {
		return false;
	}

	const prev = line[index - 1];
	if (prev === "$" || /\s/.test(prev)) {
		return false;
	}

	if (index + 1 < line.length && line[index + 1] === "$") {
		return false;
	}

	return true;
}

function containsUnescapedDollar(text: string): boolean {
	for (let i = 0; i < text.length; i++) {
		if (text[i] === "$" && !isEscaped(text, i)) {
			return true;
		}
	}
	return false;
}

function normalizeUnwrappedContent(content: string, trimWhitespace: boolean): string {
	return trimWhitespace ? content.trim() : content;
}

function flattenMultilineMath(content: string, trimWhitespace: boolean): string {
	let flattened = content.replace(/\r?\n+/g, " ").replace(/[ \t\f\v]+/g, " ");
	if (trimWhitespace) {
		flattened = flattened.trim();
	}
	return flattened;
}

function isBlockMath(input: string): boolean {
	const candidate = input.trim();
	return candidate.startsWith("$$") && candidate.endsWith("$$") && candidate.length >= 4;
}

function isInlineMath(input: string): boolean {
	const candidate = input.trim();
	if (candidate.includes("\n")) {
		return false;
	}
	if (!candidate.startsWith("$") || !candidate.endsWith("$")) {
		return false;
	}
	if (candidate.startsWith("$$") || candidate.endsWith("$$")) {
		return false;
	}
	return candidate.length >= 2;
}

function unwrapBlockMath(
	input: string,
	trimWhitespace: boolean
): { ok: true; content: string } | { ok: false; reason: string } {
	if (!isBlockMath(input)) {
		return { ok: false, reason: "Selection is not a valid display math block." };
	}

	const candidate = input.trim();
	const inner = candidate.slice(2, -2);
	const content = normalizeUnwrappedContent(inner, trimWhitespace);

	if (content.length === 0) {
		return { ok: false, reason: "Display math block is empty." };
	}

	return { ok: true, content };
}

function unwrapInlineMath(
	input: string,
	trimWhitespace: boolean
): { ok: true; content: string } | { ok: false; reason: string } {
	if (!isInlineMath(input)) {
		return { ok: false, reason: "Selection is not a valid inline math expression." };
	}

	const candidate = input.trim();
	const inner = candidate.slice(1, -1);
	const content = normalizeUnwrappedContent(inner, trimWhitespace);

	if (content.length === 0) {
		return { ok: false, reason: "Inline math expression is empty." };
	}

	if (containsUnescapedDollar(content)) {
		return {
			ok: false,
			reason: "Inline math expression appears ambiguous due to unescaped '$' inside content."
		};
	}

	return { ok: true, content };
}

function wrapAsInlineMath(content: string): string {
	return `$${content}$`;
}

function wrapAsBlockMath(content: string): string {
	return `$$\n${content}\n$$`;
}

function findInlineMathRangesInLine(line: string): InlineLineRange[] {
	const ranges: InlineLineRange[] = [];
	let openIndex: number | null = null;

	for (let i = 0; i < line.length; i++) {
		if (line[i] !== "$" || isEscaped(line, i)) {
			continue;
		}

		const isDouble = i + 1 < line.length && line[i + 1] === "$" && !isEscaped(line, i + 1);
		if (isDouble) {
			i++;
			continue;
		}

		if (openIndex === null) {
			if (isLikelyInlineOpeningDelimiter(line, i)) {
				openIndex = i;
			}
			continue;
		}

		if (!isLikelyInlineClosingDelimiter(line, i)) {
			continue;
		}

		const inner = line.slice(openIndex + 1, i);
		if (inner.trim().length > 0) {
			ranges.push({ start: openIndex, end: i + 1 });
		}
		openIndex = null;
	}

	return ranges;
}

function findInlineMathAroundCursor(editor: Editor): EditorRange | null {
	const cursor = editor.getCursor();
	const line = editor.getLine(cursor.line);
	const ranges = findInlineMathRangesInLine(line);

	const activeRange = ranges.find((range) => cursor.ch >= range.start && cursor.ch <= range.end);
	if (!activeRange) {
		return null;
	}

	return {
		from: { line: cursor.line, ch: activeRange.start },
		to: { line: cursor.line, ch: activeRange.end }
	};
}

function findBlockMathRangesInText(text: string): OffsetRange[] {
	const ranges: OffsetRange[] = [];
	let openIndex: number | null = null;

	for (let i = 0; i < text.length - 1; i++) {
		if (text[i] !== "$" || text[i + 1] !== "$" || isEscaped(text, i)) {
			continue;
		}

		const previousIsDollar = i > 0 && text[i - 1] === "$";
		const nextIsDollar = i + 2 < text.length && text[i + 2] === "$";
		if (previousIsDollar || nextIsDollar) {
			continue;
		}

		if (openIndex === null) {
			openIndex = i;
		} else {
			const inner = text.slice(openIndex + 2, i);
			if (inner.trim().length > 0) {
				ranges.push({ start: openIndex, end: i + 2 });
			}
			openIndex = null;
		}
		i++;
	}

	return ranges;
}

function buildLineStartOffsets(editor: Editor): number[] {
	const offsets: number[] = [];
	let currentOffset = 0;

	for (let line = 0; line < editor.lineCount(); line++) {
		offsets.push(currentOffset);
		currentOffset += editor.getLine(line).length;
		if (line < editor.lineCount() - 1) {
			currentOffset += 1; // Editor text uses "\n" as line separator.
		}
	}

	return offsets;
}

function editorPositionToOffset(editor: Editor, position: EditorPosition): number {
	const offsets = buildLineStartOffsets(editor);
	return offsets[position.line] + position.ch;
}

function offsetToEditorPosition(editor: Editor, offset: number): EditorPosition {
	const offsets = buildLineStartOffsets(editor);
	let low = 0;
	let high = offsets.length - 1;

	while (low <= high) {
		const mid = Math.floor((low + high) / 2);
		const lineStart = offsets[mid];
		const nextLineStart = mid + 1 < offsets.length ? offsets[mid + 1] : Number.POSITIVE_INFINITY;

		if (offset < lineStart) {
			high = mid - 1;
		} else if (offset >= nextLineStart) {
			low = mid + 1;
		} else {
			return { line: mid, ch: offset - lineStart };
		}
	}

	return { line: 0, ch: 0 };
}

function findBlockMathAroundCursor(editor: Editor): EditorRange | null {
	const text = editor.getValue();
	const cursorOffset = editorPositionToOffset(editor, editor.getCursor());
	const ranges = findBlockMathRangesInText(text);

	const activeRange = ranges.find(
		(range) => cursorOffset >= range.start && cursorOffset <= range.end
	);
	if (!activeRange) {
		return null;
	}

	return {
		from: offsetToEditorPosition(editor, activeRange.start),
		to: offsetToEditorPosition(editor, activeRange.end)
	};
}

function replaceEditorRange(editor: Editor, range: EditorRange, replacement: string): void {
	editor.replaceRange(replacement, range.from, range.to);
}

export default class MathInlineBlockTogglePlugin extends Plugin {
	settings: MathInlineBlockToggleSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: "convert-block-math-to-inline",
			name: "Convert block math to inline math",
			editorCallback: (editor) => this.convertBlockToInline(editor)
		});

		this.addCommand({
			id: "convert-inline-math-to-block",
			name: "Convert inline math to block math",
			editorCallback: (editor) => this.convertInlineToBlock(editor)
		});

		this.registerEvent(
			this.app.workspace.on("editor-menu", (menu, editor) => {
				if (!this.settings.showInContextMenu) {
					return;
				}

				menu.addItem((item) =>
					item
						.setTitle("Toggle Math Inline/Block")
						.setIcon("sigma")
						.onClick(() => this.toggleMathInlineBlock(editor))
				);
			})
		);

		this.addSettingTab(new MathInlineBlockToggleSettingTab(this.app, this));
	}

	async loadSettings(): Promise<void> {
		this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
	}

	async saveSettings(): Promise<void> {
		await this.saveData(this.settings);
	}

	private convertBlockToInline(editor: Editor): void {
		const selection = editor.getSelection();

		if (selection.length > 0) {
			const unwrapped = unwrapBlockMath(selection, this.settings.trimSurroundingWhitespace);
			if (!unwrapped.ok) {
				new Notice(unwrapped.reason);
				return;
			}
			const flattened = flattenMultilineMath(
				unwrapped.content,
				this.settings.trimSurroundingWhitespace
			);
			if (flattened.length === 0) {
				new Notice("Display math block is empty.");
				return;
			}
			editor.replaceSelection(wrapAsInlineMath(flattened));
			return;
		}

		const range = findBlockMathAroundCursor(editor);
		if (!range) {
			new Notice("No block math found at cursor.");
			return;
		}

		const text = editor.getRange(range.from, range.to);
		const unwrapped = unwrapBlockMath(text, this.settings.trimSurroundingWhitespace);
		if (!unwrapped.ok) {
			new Notice(unwrapped.reason);
			return;
		}

		const flattened = flattenMultilineMath(
			unwrapped.content,
			this.settings.trimSurroundingWhitespace
		);
		if (flattened.length === 0) {
			new Notice("Display math block is empty.");
			return;
		}
		replaceEditorRange(editor, range, wrapAsInlineMath(flattened));
	}

	private convertInlineToBlock(editor: Editor): void {
		const selection = editor.getSelection();

		if (selection.length > 0) {
			const unwrapped = unwrapInlineMath(selection, this.settings.trimSurroundingWhitespace);
			if (!unwrapped.ok) {
				new Notice(unwrapped.reason);
				return;
			}
			const flattened = flattenMultilineMath(
				unwrapped.content,
				this.settings.trimSurroundingWhitespace
			);
			if (flattened.length === 0) {
				new Notice("Inline math expression is empty.");
				return;
			}

			editor.replaceSelection(wrapAsBlockMath(flattened));
			return;
		}

		const range = findInlineMathAroundCursor(editor);
		if (!range) {
			new Notice("No inline math found at cursor.");
			return;
		}

		const text = editor.getRange(range.from, range.to);
		const unwrapped = unwrapInlineMath(text, this.settings.trimSurroundingWhitespace);
		if (!unwrapped.ok) {
			new Notice(unwrapped.reason);
			return;
		}
		const flattened = flattenMultilineMath(
			unwrapped.content,
			this.settings.trimSurroundingWhitespace
		);
		if (flattened.length === 0) {
			new Notice("Inline math expression is empty.");
			return;
		}

		replaceEditorRange(editor, range, wrapAsBlockMath(flattened));
	}

	private toggleMathInlineBlock(editor: Editor): void {
		const selection = editor.getSelection();
		if (selection.length > 0) {
			const asBlock = unwrapBlockMath(selection, this.settings.trimSurroundingWhitespace);
			if (asBlock.ok) {
				const flattened = flattenMultilineMath(
					asBlock.content,
					this.settings.trimSurroundingWhitespace
				);
				if (flattened.length === 0) {
					new Notice("Display math block is empty.");
					return;
				}
				editor.replaceSelection(wrapAsInlineMath(flattened));
				return;
			}

			const asInline = unwrapInlineMath(selection, this.settings.trimSurroundingWhitespace);
			if (asInline.ok) {
				const flattened = flattenMultilineMath(
					asInline.content,
					this.settings.trimSurroundingWhitespace
				);
				if (flattened.length === 0) {
					new Notice("Inline math expression is empty.");
					return;
				}
				editor.replaceSelection(wrapAsBlockMath(flattened));
				return;
			}

			new Notice("Selection is neither valid block math nor valid inline math.");
			return;
		}

		const blockRange = findBlockMathAroundCursor(editor);
		const inlineRange = findInlineMathAroundCursor(editor);

		if (blockRange && !inlineRange) {
			const text = editor.getRange(blockRange.from, blockRange.to);
			const unwrapped = unwrapBlockMath(text, this.settings.trimSurroundingWhitespace);
			if (!unwrapped.ok) {
				new Notice(unwrapped.reason);
				return;
			}
			const flattened = flattenMultilineMath(
				unwrapped.content,
				this.settings.trimSurroundingWhitespace
			);
			if (flattened.length === 0) {
				new Notice("Display math block is empty.");
				return;
			}
			replaceEditorRange(editor, blockRange, wrapAsInlineMath(flattened));
			return;
		}

		if (inlineRange && !blockRange) {
			const text = editor.getRange(inlineRange.from, inlineRange.to);
			const unwrapped = unwrapInlineMath(text, this.settings.trimSurroundingWhitespace);
			if (!unwrapped.ok) {
				new Notice(unwrapped.reason);
				return;
			}
			const flattened = flattenMultilineMath(
				unwrapped.content,
				this.settings.trimSurroundingWhitespace
			);
			if (flattened.length === 0) {
				new Notice("Inline math expression is empty.");
				return;
			}
			replaceEditorRange(editor, inlineRange, wrapAsBlockMath(flattened));
			return;
		}

		if (blockRange && inlineRange) {
			const blockLen =
				editorPositionToOffset(editor, blockRange.to) -
				editorPositionToOffset(editor, blockRange.from);
			const inlineLen =
				editorPositionToOffset(editor, inlineRange.to) -
				editorPositionToOffset(editor, inlineRange.from);

			// Deterministic tie-breaker for ambiguous cursor-contained matches:
			// prefer the narrower range, otherwise show a notice.
			if (inlineLen < blockLen) {
				const text = editor.getRange(inlineRange.from, inlineRange.to);
				const unwrapped = unwrapInlineMath(text, this.settings.trimSurroundingWhitespace);
				if (!unwrapped.ok) {
					new Notice(unwrapped.reason);
					return;
				}
				const flattened = flattenMultilineMath(
					unwrapped.content,
					this.settings.trimSurroundingWhitespace
				);
				if (flattened.length === 0) {
					new Notice("Inline math expression is empty.");
					return;
				}
				replaceEditorRange(editor, inlineRange, wrapAsBlockMath(flattened));
				return;
			}

			if (blockLen < inlineLen) {
				const text = editor.getRange(blockRange.from, blockRange.to);
				const unwrapped = unwrapBlockMath(text, this.settings.trimSurroundingWhitespace);
				if (!unwrapped.ok) {
					new Notice(unwrapped.reason);
					return;
				}
				const flattened = flattenMultilineMath(
					unwrapped.content,
					this.settings.trimSurroundingWhitespace
				);
				if (flattened.length === 0) {
					new Notice("Display math block is empty.");
					return;
				}
				replaceEditorRange(editor, blockRange, wrapAsInlineMath(flattened));
				return;
			}

			new Notice("Ambiguous math expression at cursor.");
			return;
		}

		new Notice("No inline or block math found at cursor.");
	}
}

class MathInlineBlockToggleSettingTab extends PluginSettingTab {
	plugin: MathInlineBlockTogglePlugin;

	constructor(app: App, plugin: MathInlineBlockTogglePlugin) {
		super(app, plugin);
		this.plugin = plugin;
	}

	display(): void {
		const { containerEl } = this;
		containerEl.empty();

		containerEl.createEl("h2", { text: "math-inline-block-toggle" });

		new Setting(containerEl)
			.setName("Show commands in editor context menu")
			.setDesc("Show a unified math toggle action in the editor right-click menu.")
			.addToggle((toggle) =>
				toggle.setValue(this.plugin.settings.showInContextMenu).onChange(async (value) => {
					this.plugin.settings.showInContextMenu = value;
					await this.plugin.saveSettings();
				})
			);

		new Setting(containerEl)
			.setName("Trim surrounding whitespace when converting")
			.setDesc(
				"If enabled, remove leading/trailing whitespace around unwrapped math content during conversion."
			)
			.addToggle((toggle) =>
				toggle
					.setValue(this.plugin.settings.trimSurroundingWhitespace)
					.onChange(async (value) => {
						this.plugin.settings.trimSurroundingWhitespace = value;
						await this.plugin.saveSettings();
					})
			);
	}
}
