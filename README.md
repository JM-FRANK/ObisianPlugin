# obisian-Latex-inline-block-toggle
Release page: https://github.com/JM-FRANK/Obisian-Latex-inline-block-toggle

Convert LaTeX math between inline (`$...$`) and display block (`$$...$$`) styles directly in the Obsidian editor.

## Features

- Two editor commands:
  - `Convert block math to inline math`
  - `Convert inline math to block math`
- Commands are registered through Obsidian's official command system so users can set their own hotkeys.
- Both actions are available in the editor right-click context menu (configurable).
- Selection-aware behavior:
  - If text is selected, conversion runs on the selection.
  - If no text is selected, the plugin detects the math expression around the cursor.
- Friendly `Notice` messages when conversion cannot be safely performed.
- Settings for context menu visibility, whitespace trimming, and block output style.

## Demo (Text)

### Block to inline

Input:

```latex
$$
\lim_{n \to \infty} a_n = L.
$$
```

Output:

```latex
$\lim_{n \to \infty} a_n = L.$
```

### Inline to block

Input:

```latex
$\lim_{n \to \infty} a_n = L.$
```

Output (default multiline style):

```latex
$$
\lim_{n \to \infty} a_n = L.
$$
```

## Installation (Manual Sideload)

1. Build the plugin (see build steps below).
2. Create a folder in your vault:
   - `.obsidian/plugins/obisian-latex-inline-block-toggle/`
3. Copy these files into that folder:
   - `main.js`
   - `manifest.json`
   - `styles.css`
4. In Obsidian:
   - Open `Settings -> Community plugins`
   - Disable Safe mode (if needed)
   - Enable `obisian-Latex-inline-block-toggle`

## Development Setup

1. Clone this repository.
2. Install dependencies:

```bash
npm install
```

3. For development watch mode:

```bash
npm run dev
```

4. For a production build:

```bash
npm run build
```

## Build Instructions

- `npm run dev`:
  - Watches `main.ts` and rebuilds `main.js` on changes.
- `npm run build`:
  - Creates a production bundle (`main.js`).
- `npm run version`:
  - Updates `versions.json` using `manifest.json` values.

## How Commands Work

### Convert block math to inline math

- With selection:
  - Expects a complete display block delimited by `$$ ... $$`.
  - Removes outer delimiters and wraps content as inline math.
- Without selection:
  - Detects whether the cursor is inside a `$$ ... $$` block.
  - Converts the full detected block.
- Failure examples:
  - Not a complete block expression.
  - Empty or malformed block content.

### Convert inline math to block math

- With selection:
  - Expects a complete inline expression delimited by `$ ... $`.
  - Removes outer delimiters and wraps content as display math.
- Without selection:
  - Detects an inline math expression around the cursor on the current line.
  - Converts the full detected expression.
- Failure examples:
  - No inline math at cursor.
  - Ambiguous/malformed expression.

## Settings

Open `Settings -> Community plugins -> obisian-Latex-inline-block-toggle`:

- `Show commands in editor context menu` (default: `true`)
  - Show/hide the conversion actions in the editor right-click menu.
- `Trim surrounding whitespace when converting` (default: `true`)
  - Trims extracted math content during conversion.
- `Use multiline block math style` (default: `true`)
  - If enabled, inline-to-block output is:

```latex
$$
formula
$$
```

  - If disabled, output uses single-line display style:

```latex
$$ formula $$
```

## Edge Cases and Limitations

- Inline detection is intentionally restricted to the current line.
- Escaped dollar signs (`\$`) are not treated as delimiters.
- The plugin distinguishes single-dollar and double-dollar delimiters.
- Heuristics are used to avoid obvious currency false positives, but not every ambiguous case can be perfectly inferred.
- Malformed or deeply ambiguous delimiter patterns are safely rejected with a notice.
- Fenced math blocks like ```` ```math ```` are not supported (by design).
- This plugin does not implement a full LaTeX parser.

## License

MIT. See [LICENSE](LICENSE).
