import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = [];

function walk(dir) {
	for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) walk(full);
		else if (entry.isFile() && entry.name.endsWith(".test.mjs")) files.push(full);
	}
}

walk(path.join(root, "test"));
files.sort();
const result = spawnSync(process.execPath, ["--test", ...files], { stdio: "inherit", env: process.env });
if (result.error) {
	console.error(result.error.message);
	process.exit(1);
}
process.exit(result.status == null ? 1 : result.status);
