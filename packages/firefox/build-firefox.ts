#!/usr/bin/env bun
/**
 * Build script for Agent Blame Firefox Extension
 *
 * Compiles TypeScript and bundles for Firefox extension.
 * Source code lives in ../extension/src/, this script only handles
 * Firefox-specific manifest and packaging.
 */

import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync, rmSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { execSync } from "node:child_process";

const EXTENSION_SRC = join(import.meta.dir, "..", "extension", "src");
const MANIFEST_FILE = join(import.meta.dir, "manifest.json");
const DIST_DIR = join(import.meta.dir, "dist");

/**
 * Clean dist directory
 */
function clean(): void {
  if (existsSync(DIST_DIR)) {
    rmSync(DIST_DIR, { recursive: true });
  }
  mkdirSync(DIST_DIR, { recursive: true });
}

/**
 * Copy static files
 */
function copyStatic(): void {
  // Create subdirectories
  mkdirSync(join(DIST_DIR, "popup"), { recursive: true });
  mkdirSync(join(DIST_DIR, "content"), { recursive: true });
  mkdirSync(join(DIST_DIR, "background"), { recursive: true });
  mkdirSync(join(DIST_DIR, "icons"), { recursive: true });

  // Copy Firefox-specific manifest
  copyFileSync(MANIFEST_FILE, join(DIST_DIR, "manifest.json"));

  // Copy popup HTML and CSS from shared source
  copyFileSync(join(EXTENSION_SRC, "popup", "popup.html"), join(DIST_DIR, "popup", "popup.html"));
  copyFileSync(join(EXTENSION_SRC, "popup", "popup.css"), join(DIST_DIR, "popup", "popup.css"));

  // Copy content CSS from shared source
  copyFileSync(join(EXTENSION_SRC, "content", "content.css"), join(DIST_DIR, "content", "content.css"));
  copyFileSync(join(EXTENSION_SRC, "content", "chart.css"), join(DIST_DIR, "content", "chart.css"));

  // Copy icons from shared source
  const iconsDir = join(EXTENSION_SRC, "icons");
  if (existsSync(iconsDir)) {
    for (const file of readdirSync(iconsDir)) {
      if (file.startsWith(".")) continue;
      copyFileSync(join(iconsDir, file), join(DIST_DIR, "icons", file));
    }
  }

  console.log("✓ Copied static files");
}

/**
 * Bundle TypeScript files
 */
async function bundle(): Promise<void> {
  // Bundle popup
  await build({
    entryPoints: [join(EXTENSION_SRC, "popup", "popup.ts")],
    bundle: true,
    outfile: join(DIST_DIR, "popup", "popup.js"),
    format: "iife",
    target: "firefox109",
    minify: false,
    sourcemap: true,
  });
  console.log("✓ Bundled popup.js");

  // Bundle unified content script router
  await build({
    entryPoints: [join(EXTENSION_SRC, "content", "router.ts")],
    bundle: true,
    outfile: join(DIST_DIR, "content", "router.js"),
    format: "iife",
    target: "firefox109",
    minify: false,
    sourcemap: true,
  });
  console.log("✓ Bundled router.js");

  // Bundle background script
  // Firefox MV3 uses "scripts" instead of "service_worker", bundled as IIFE
  await build({
    entryPoints: [join(EXTENSION_SRC, "background", "background.ts")],
    bundle: true,
    outfile: join(DIST_DIR, "background", "background.js"),
    format: "iife",
    target: "firefox109",
    minify: false,
    sourcemap: true,
  });
  console.log("✓ Bundled background.js");
}

/**
 * Create placeholder icons if they don't exist
 */
function createPlaceholderIcons(): void {
  const iconsDir = join(DIST_DIR, "icons");
  const icon16 = join(iconsDir, "icon16.png");
  if (!existsSync(icon16)) {
    console.log("⚠ No icons found - extension will use default icon");
    console.log("  Add icons to packages/extension/src/icons/ (icon16.png, icon48.png, icon128.png)");
  }
}

/**
 * Create zip file for Firefox Add-ons submission
 */
function createZip(): string {
  const manifest = JSON.parse(readFileSync(join(DIST_DIR, "manifest.json"), "utf-8"));
  const version = manifest.version;
  const zipName = `agentblame-firefox-${version}.zip`;
  const zipPath = join(import.meta.dir, zipName);

  if (existsSync(zipPath)) {
    rmSync(zipPath);
  }

  execSync(`cd "${DIST_DIR}" && zip -r "${zipPath}" .`, { stdio: "pipe" });

  console.log(`✓ Created ${zipName}`);
  return zipPath;
}

/**
 * Main build function
 */
async function main(): Promise<void> {
  console.log("Building Agent Blame Firefox Extension...\n");

  try {
    clean();
    copyStatic();
    await bundle();
    createPlaceholderIcons();
    const zipPath = createZip();

    console.log("\n✓ Build complete!");
    console.log(`  Output: ${DIST_DIR}`);
    console.log(`  Zip: ${zipPath}`);
    console.log("\nTo load in Firefox:");
    console.log("  1. Go to about:debugging#/runtime/this-firefox");
    console.log("  2. Click 'Load Temporary Add-on...'");
    console.log(`  3. Select: ${join(DIST_DIR, "manifest.json")}`);
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

main();
