/**
 * Updates versions.json with a new version entry.
 * This script is called by the release-please workflow after a release is created.
 *
 * Usage: node scripts/update-versions.mjs <version>
 *
 * The versions.json file maps plugin versions to their minimum required Obsidian version.
 * This allows Obsidian to download compatible plugin versions for older Obsidian installations.
 */

import { readFileSync, writeFileSync } from "fs";

const version = process.argv[2];

if (!version) {
  console.error("Usage: node scripts/update-versions.mjs <version>");
  process.exit(1);
}

// Read manifest.json to get the minAppVersion
const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const minAppVersion = manifest.minAppVersion;

// Read and update versions.json
const versions = JSON.parse(readFileSync("versions.json", "utf8"));

// Add the new version mapping
versions[version] = minAppVersion;

// Write back to versions.json with consistent formatting
writeFileSync("versions.json", JSON.stringify(versions, null, 2) + "\n");

console.log(`Updated versions.json: ${version} -> ${minAppVersion}`);
