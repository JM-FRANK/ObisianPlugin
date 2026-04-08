import esbuild from "esbuild";
import process from "node:process";
import builtins from "builtin-modules";

const production = process.argv[2] === "production";
const watch = !production;

const context = await esbuild.context({
	bundle: true,
	entryPoints: ["main.ts"],
	external: [
		"obsidian",
		"electron",
		"@codemirror/autocomplete",
		"@codemirror/collab",
		"@codemirror/commands",
		"@codemirror/language",
		"@codemirror/lint",
		"@codemirror/search",
		"@codemirror/state",
		"@codemirror/view",
		...builtins
	],
	format: "cjs",
	target: "es2020",
	logLevel: "info",
	sourcemap: production ? false : "inline",
	treeShaking: true,
	outfile: "main.js"
});

if (watch) {
	await context.watch();
	console.log("Watching for changes...");
} else {
	await context.rebuild();
	await context.dispose();
}
