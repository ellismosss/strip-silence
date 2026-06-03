import * as fs from "node:fs";

const manifest = JSON.parse(fs.readFileSync("manifest.json", "utf8"));
const pkg = JSON.parse(fs.readFileSync("package.json", "utf8"));

const [major, minor, patch] = (manifest.version as string).split(".").map(Number);
const next = `${major}.${minor}.${patch + 1}`;

manifest.version = next;
pkg.version = next;

fs.writeFileSync("manifest.json", JSON.stringify(manifest, null, 4) + "\n");
fs.writeFileSync("package.json", JSON.stringify(pkg, null, 2) + "\n");

console.log(`Version bumped: ${major}.${minor}.${patch} → ${next}`);
