import fs from "node:fs";
import path from "node:path";
import process from "node:process";

const root = process.cwd();
const manifestPath = path.join(root, "manifest.json");
const versionsPath = path.join(root, "versions.json");

const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const versions = JSON.parse(fs.readFileSync(versionsPath, "utf8"));

if (typeof manifest.version !== "string" || manifest.version.trim().length === 0) {
	throw new Error("manifest.json must contain a non-empty version field.");
}

if (typeof manifest.minAppVersion !== "string" || manifest.minAppVersion.trim().length === 0) {
	throw new Error("manifest.json must contain a non-empty minAppVersion field.");
}

versions[manifest.version] = manifest.minAppVersion;

fs.writeFileSync(versionsPath, `${JSON.stringify(versions, null, "\t")}\n`, "utf8");
console.log(`Updated versions.json for ${manifest.version} -> ${manifest.minAppVersion}`);
