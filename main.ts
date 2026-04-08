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

interface BlockMathMatch {
	range: EditorRange;
	startOffset: number;
	endOffset: number;
	content: string;
	quotePrefix: string | null;
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

function flattenBlockMathContent(content: string, trimWhitespace: boolean): string {
	let flattened = content.replace(/\r?\n+/g, " ").replace(/[ \t\f\v]+/g, " ");
	if (trimWhitespace) {
		flattened = flattened.trim();
	}
	return flattened;
}

function normalizeQuotePrefix(text: string): string | null {
	const match = text.match(/^(\s*(?:>\s?)*)/);
	if (!match) {
		return null;
	}
	const prefix = match[1];
	return prefix.includes(">") ? prefix : null;
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

function wrapAsBlockMath(content: string, quotePrefix: string | null = null): string {
	const lines = ["$$", content, "$$"];
	if (!quotePrefix) {
		return lines.join("\n");
	}
	return lines.map((line) => `${quotePrefix}${line}`).join("\n");
}

function formatBlockMathContent(content: string, trimWhitespace: boolean): string {
	let normalized = normalizeUnwrappedContent(content, trimWhitespace);
	normalized = normalized.replace(/\r?\n+/g, " ").replace(/[ \t\f\v]+/g, " ");
	if (trimWhitespace) {
		normalized = normalized.trim();
	}

	if (!normalized.includes("\\\\")) {
		return normalized;
	}

	const parts = normalized.split(/\\\\/g).map((part) => part.trim());
	return parts
		.map((part, index) => (index < parts.length - 1 ? `${part} \\\\` : part))
		.join("\n");
}

function lineMatchesQuotePrefix(line: string, quotePrefix: string | null): boolean {
	const linePrefix = normalizeQuotePrefix(line);
	if (quotePrefix === null) {
		return linePrefix === null;
	}
	return line.startsWith(quotePrefix);
}

function extractLineBody(line: string, quotePrefix: string | null): string {
	if (!quotePrefix) {
		return line;
	}
	return line.startsWith(quotePrefix) ? line.slice(quotePrefix.length) : line;
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

function replaceEditorRange(editor: Editor, range: EditorRange, replacement: string): void {
	editor.replaceRange(replacement, range.from, range.to);
}

function stripQuotePrefixFromInterstice(text: string): string {
	return text.replace(/^\s*(?:>\s?)*/gm, "").trim();
}

function buildBlockMathMatch(
	editor: Editor,
	range: EditorRange,
	trimWhitespace: boolean
): BlockMathMatch | null {
	const raw = editor.getRange(range.from, range.to);
	const openingLinePrefix = editor.getLine(range.from.line).slice(0, range.from.ch);
	const quotePrefix = normalizeQuotePrefix(openingLinePrefix);

	const lines = raw.split("\n");
	if (quotePrefix) {
		for (let i = 1; i < lines.length; i++) {
			if (lines[i].startsWith(quotePrefix)) {
				lines[i] = lines[i].slice(quotePrefix.length);
			}
		}
	}

	const maybeBlock = lines.join("\n");
	const unwrapped = unwrapBlockMath(maybeBlock, trimWhitespace);
	if (!unwrapped.ok) {
		return null;
	}

	return {
		range,
		startOffset: editorPositionToOffset(editor, range.from),
		endOffset: editorPositionToOffset(editor, range.to),
		content: unwrapped.content,
		quotePrefix
	};
}

function buildAllBlockMathMatches(editor: Editor, trimWhitespace: boolean): BlockMathMatch[] {
	const text = editor.getValue();
	const ranges = findBlockMathRangesInText(text);
	const matches: BlockMathMatch[] = [];

	for (const offsetRange of ranges) {
		const range: EditorRange = {
			from: offsetToEditorPosition(editor, offsetRange.start),
			to: offsetToEditorPosition(editor, offsetRange.end)
		};
		const match = buildBlockMathMatch(editor, range, trimWhitespace);
		if (match) {
			matches.push(match);
		}
	}

	return matches;
}

function areMergeableNeighbors(
	fullText: string,
	left: BlockMathMatch,
	right: BlockMathMatch
): boolean {
	if (left.quotePrefix !== right.quotePrefix) {
		return false;
	}
	if (left.endOffset > right.startOffset) {
		return false;
	}

	const interstice = fullText.slice(left.endOffset, right.startOffset);
	return stripQuotePrefixFromInterstice(interstice).length === 0;
}

function findConsecutiveBlockMathGroup(
	fullText: string,
	matches: BlockMathMatch[],
	index: number
): BlockMathMatch[] {
	let left = index;
	let right = index;

	while (left > 0 && areMergeableNeighbors(fullText, matches[left - 1], matches[left])) {
		left--;
	}
	while (
		right < matches.length - 1 &&
		areMergeableNeighbors(fullText, matches[right], matches[right + 1])
	) {
		right++;
	}

	return matches.slice(left, right + 1);
}

function mergeConsecutiveBlockMath(
	blocks: BlockMathMatch[],
	trimWhitespace: boolean
): { range: EditorRange; merged: string } | null {
	if (blocks.length < 2) {
		return null;
	}

	const quotePrefix = blocks[0].quotePrefix;
	const formulaLines = blocks.map((block) =>
		flattenBlockMathContent(block.content, trimWhitespace)
	);

	if (formulaLines.some((line) => line.length === 0)) {
		return null;
	}

	const alignedLines = formulaLines.map((line, i) =>
		i < formulaLines.length - 1 ? `${line} \\\\` : line
	);
	const alignedContent = ["\\begin{aligned}", ...alignedLines, "\\end{aligned}"].join("\n");
	const merged = wrapAsBlockMath(alignedContent, quotePrefix);

	return {
		range: {
			from: blocks[0].range.from,
			to: blocks[blocks.length - 1].range.to
		},
		merged
	};
}

function findAllInlineMathOnLine(editor: Editor, lineNumber: number): InlineLineRange[] {
	return findInlineMathRangesInLine(editor.getLine(lineNumber));
}

export default class MathInlineBlockTogglePlugin extends Plugin {
	settings: MathInlineBlockToggleSettings = DEFAULT_SETTINGS;

	async onload(): Promise<void> {
		await this.loadSettings();

		this.addCommand({
			id: "toggle-math-inline-block",
			name: "Toggle math inline/block",
			editorCallback: (editor) => this.toggleMathInlineBlock(editor)
		});

		this.addCommand({
			id: "merge-consecutive-block-formulas",
			name: "Merge consecutive block formulas",
			editorCallback: (editor) => this.mergeConsecutiveBlockFormulas(editor)
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

				menu.addItem((item) =>
					item
						.setTitle("Merge consecutive block formulas")
						.setIcon("whole-word")
						.onClick(() => this.mergeConsecutiveBlockFormulas(editor))
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

	private convertBlockMatchToInline(editor: Editor, block: BlockMathMatch): void {
		const flattened = flattenBlockMathContent(block.content, this.settings.trimSurroundingWhitespace);
		if (flattened.length === 0) {
			new Notice("Display math block is empty.");
			return;
		}

		const inlineMath = wrapAsInlineMath(flattened);
		this.mergeSurroundingTextForBlockToInline(editor, block, inlineMath);
	}

	private convertInlineTextToBlock(
		inlineText: string,
		quotePrefix: string | null
	): { ok: true; replacement: string } | { ok: false; reason: string } {
		const unwrapped = unwrapInlineMath(inlineText, this.settings.trimSurroundingWhitespace);
		if (!unwrapped.ok) {
			return unwrapped;
		}

		const formatted = formatBlockMathContent(
			unwrapped.content,
			this.settings.trimSurroundingWhitespace
		);
		if (formatted.length === 0) {
			return { ok: false, reason: "Inline math expression is empty." };
		}

		return { ok: true, replacement: wrapAsBlockMath(formatted, quotePrefix) };
	}

	private convertAllInlineMathOnLine(editor: Editor, lineNumber: number): boolean {
		const line = editor.getLine(lineNumber);
		const ranges = findAllInlineMathOnLine(editor, lineNumber);
		if (ranges.length === 0) {
			return false;
		}

		const quotePrefix = normalizeQuotePrefix(line);
		const prefixLen = quotePrefix ? quotePrefix.length : 0;
		const lineBody = extractLineBody(line, quotePrefix);
		const outputLines: string[] = [];
		let bodyCursor = 0;

		for (const range of ranges) {
			const bodyStart = range.start - prefixLen;
			const bodyEnd = range.end - prefixLen;
			if (bodyStart < 0 || bodyEnd < bodyStart || bodyEnd > lineBody.length) {
				continue;
			}

			const textSegment = lineBody.slice(bodyCursor, bodyStart).trim();
			if (textSegment.length > 0) {
				outputLines.push(`${quotePrefix ?? ""}${textSegment}`);
			}

			const inlineText = lineBody.slice(bodyStart, bodyEnd);
			const converted = this.convertInlineTextToBlock(inlineText, quotePrefix);
			if (!converted.ok) {
				new Notice(converted.reason);
				return true;
			}

			outputLines.push(converted.replacement);
			bodyCursor = bodyEnd;
		}

		const tailSegment = lineBody.slice(bodyCursor).trim();
		if (tailSegment.length > 0) {
			outputLines.push(`${quotePrefix ?? ""}${tailSegment}`);
		}

		editor.replaceRange(
			outputLines.join("\n"),
			{ line: lineNumber, ch: 0 },
			{ line: lineNumber, ch: line.length }
		);

		return true;
	}

	private tryMergeSelectionBlocks(editor: Editor): boolean {
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");
		const selectionStart = editorPositionToOffset(editor, from);
		const selectionEnd = editorPositionToOffset(editor, to);
		if (selectionStart === selectionEnd) {
			return false;
		}

		const fullText = editor.getValue();
		const matches = buildAllBlockMathMatches(editor, this.settings.trimSurroundingWhitespace);
		const contained = matches.filter(
			(match) => match.startOffset >= selectionStart && match.endOffset <= selectionEnd
		);
		if (contained.length < 2) {
			return false;
		}

		const first = contained[0];
		const last = contained[contained.length - 1];
		const before = fullText.slice(selectionStart, first.startOffset);
		const after = fullText.slice(last.endOffset, selectionEnd);
		if (
			stripQuotePrefixFromInterstice(before).length > 0 ||
			stripQuotePrefixFromInterstice(after).length > 0
		) {
			return false;
		}

		for (let i = 0; i < contained.length - 1; i++) {
			if (!areMergeableNeighbors(fullText, contained[i], contained[i + 1])) {
				return false;
			}
		}

		const merged = mergeConsecutiveBlockMath(contained, this.settings.trimSurroundingWhitespace);
		if (!merged) {
			return false;
		}

		replaceEditorRange(editor, merged.range, merged.merged);
		return true;
	}

	private toggleSelection(editor: Editor): void {
		const selection = editor.getSelection();
		if (selection.length === 0) {
			return;
		}
		const from = editor.getCursor("from");
		const to = editor.getCursor("to");

		const selectedBlock = unwrapBlockMath(selection, this.settings.trimSurroundingWhitespace);
		if (selectedBlock.ok) {
			const flattened = flattenBlockMathContent(
				selectedBlock.content,
				this.settings.trimSurroundingWhitespace
			);
			if (flattened.length === 0) {
				new Notice("Display math block is empty.");
				return;
			}
			editor.replaceSelection(wrapAsInlineMath(flattened));
			return;
		}

		// Fallback: selection may contain quoted block math (e.g., "> $$ ... > $$").
		const fullText = editor.getValue();
		const selectionStart = editorPositionToOffset(editor, from);
		const selectionEnd = editorPositionToOffset(editor, to);
		const blockMatches = buildAllBlockMathMatches(editor, this.settings.trimSurroundingWhitespace);
		const fullyContainedBlocks = blockMatches.filter(
			(match) => match.startOffset >= selectionStart && match.endOffset <= selectionEnd
		);
		if (fullyContainedBlocks.length === 1) {
			const onlyBlock = fullyContainedBlocks[0];
			const before = fullText.slice(selectionStart, onlyBlock.startOffset);
			const after = fullText.slice(onlyBlock.endOffset, selectionEnd);
			if (
				stripQuotePrefixFromInterstice(before).length === 0 &&
				stripQuotePrefixFromInterstice(after).length === 0
			) {
				const inlineMath = wrapAsInlineMath(
					flattenBlockMathContent(
						onlyBlock.content,
						this.settings.trimSurroundingWhitespace
					)
				);
				const inlineLine = onlyBlock.quotePrefix ? `${onlyBlock.quotePrefix}${inlineMath}` : inlineMath;
				replaceEditorRange(editor, onlyBlock.range, inlineLine);
				return;
			}
		}

		const quotePrefix =
			from.line === to.line ? normalizeQuotePrefix(editor.getLine(from.line)) : null;

		const selectedInline = this.convertInlineTextToBlock(selection, quotePrefix);
		if (selectedInline.ok) {
			if (from.line !== to.line) {
				editor.replaceSelection(selectedInline.replacement);
				return;
			}

			const line = editor.getLine(from.line);
			const linePrefix = quotePrefix;
			const lineBody = extractLineBody(line, linePrefix);
			const prefixLen = linePrefix ? linePrefix.length : 0;
			const bodyFrom = from.ch - prefixLen;
			const bodyTo = to.ch - prefixLen;
			if (bodyFrom < 0 || bodyTo < bodyFrom || bodyTo > lineBody.length) {
				editor.replaceSelection(selectedInline.replacement);
				return;
			}

			const beforeBody = lineBody.slice(0, bodyFrom).trimEnd();
			const afterBody = lineBody.slice(bodyTo).trimStart();
			const replacementLines: string[] = [];
			if (beforeBody.length > 0) {
				replacementLines.push(`${linePrefix ?? ""}${beforeBody}`);
			}
			replacementLines.push(selectedInline.replacement);
			if (afterBody.length > 0) {
				replacementLines.push(`${linePrefix ?? ""}${afterBody}`);
			}

			editor.replaceRange(
				replacementLines.join("\n"),
				{ line: from.line, ch: 0 },
				{ line: from.line, ch: line.length }
			);
			return;
		}

		new Notice("Selection is neither valid block math nor valid inline math.");
	}

	private mergeSurroundingTextForBlockToInline(
		editor: Editor,
		block: BlockMathMatch,
		inlineMath: string
	): void {
		const blockStartLine = block.range.from.line;
		const blockEndLine = block.range.to.line;
		const quotePrefix = block.quotePrefix;

		const beforeLine = blockStartLine - 1;
		const afterLine = blockEndLine + 1;

		let beforeBody: string | null = null;
		let afterBody: string | null = null;

		if (beforeLine >= 0) {
			const beforeText = editor.getLine(beforeLine);
			if (lineMatchesQuotePrefix(beforeText, quotePrefix)) {
				const body = extractLineBody(beforeText, quotePrefix);
				if (body.trim().length > 0) {
					beforeBody = body.replace(/[ \t]+$/g, "");
				}
			}
		}

		if (afterLine < editor.lineCount()) {
			const afterText = editor.getLine(afterLine);
			if (lineMatchesQuotePrefix(afterText, quotePrefix)) {
				const body = extractLineBody(afterText, quotePrefix);
				if (body.trim().length > 0) {
					afterBody = body.replace(/^[ \t]+/g, "");
				}
			}
		}

		if (beforeBody === null && afterBody === null) {
			const replacement = quotePrefix ? `${quotePrefix}${inlineMath}` : inlineMath;
			replaceEditorRange(editor, block.range, replacement);
			return;
		}

		const mergedParts: string[] = [];
		if (beforeBody !== null) {
			mergedParts.push(beforeBody);
		}
		mergedParts.push(inlineMath);
		if (afterBody !== null) {
			mergedParts.push(afterBody);
		}
		const mergedLine = `${quotePrefix ?? ""}${mergedParts.join(" ")}`;

		const replaceFromLine = beforeBody !== null ? beforeLine : blockStartLine;
		const replaceToLine = afterBody !== null ? afterLine : blockEndLine;
		editor.replaceRange(
			mergedLine,
			{ line: replaceFromLine, ch: 0 },
			{ line: replaceToLine, ch: editor.getLine(replaceToLine).length }
		);
	}

	private mergeConsecutiveBlockFormulas(editor: Editor): void {
		const selection = editor.getSelection();
		if (selection.length > 0) {
			if (this.tryMergeSelectionBlocks(editor)) {
				return;
			}
			new Notice("No mergeable consecutive block formulas found in selection.");
			return;
		}

		const blockMatches = buildAllBlockMathMatches(editor, this.settings.trimSurroundingWhitespace);
		const cursorOffset = editorPositionToOffset(editor, editor.getCursor());
		const blockIndex = blockMatches.findIndex(
			(match) => cursorOffset >= match.startOffset && cursorOffset <= match.endOffset
		);
		if (blockIndex === -1) {
			new Notice("No block math found at cursor.");
			return;
		}

		const fullText = editor.getValue();
		const group = findConsecutiveBlockMathGroup(fullText, blockMatches, blockIndex);
		if (group.length < 2) {
			new Notice("No consecutive block formulas to merge at cursor.");
			return;
		}

		const merged = mergeConsecutiveBlockMath(group, this.settings.trimSurroundingWhitespace);
		if (!merged) {
			new Notice("Could not merge consecutive block formulas.");
			return;
		}

		replaceEditorRange(editor, merged.range, merged.merged);
	}

	private toggleMathInlineBlock(editor: Editor): void {
		const selection = editor.getSelection();
		if (selection.length > 0) {
			this.toggleSelection(editor);
			return;
		}

		// Priority (no selection, toggle only):
		// 1) If cursor is inside a block formula, toggle block -> inline.
		// 2) Else if cursor line has inline math, convert all inline math on that line.
		// 3) Else show notice.
		const cursorOffset = editorPositionToOffset(editor, editor.getCursor());
		const blockMatches = buildAllBlockMathMatches(editor, this.settings.trimSurroundingWhitespace);
		const blockIndex = blockMatches.findIndex(
			(match) => cursorOffset >= match.startOffset && cursorOffset <= match.endOffset
		);

		if (blockIndex !== -1) {
			this.convertBlockMatchToInline(editor, blockMatches[blockIndex]);
			return;
		}

		const cursorLine = editor.getCursor().line;
		if (this.convertAllInlineMathOnLine(editor, cursorLine)) {
			return;
		}

		new Notice("No inline or block math found on this line.");
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
			.setDesc("Show math toggle and merge actions in the editor right-click menu.")
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
