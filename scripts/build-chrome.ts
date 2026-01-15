#!/usr/bin/env bun
/**
 * Build script for Agent Blame Chrome Extension
 *
 * Compiles TypeScript and bundles for Chrome extension
 */

import { build } from "esbuild";
import { copyFileSync, mkdirSync, existsSync, rmSync, readdirSync } from "node:fs";
import { join, dirname } from "node:path";

const SRC_DIR = join(import.meta.dir, "..", "src", "chrome");
const DIST_DIR = join(import.meta.dir, "..", "dist", "chrome");

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

  // Copy manifest
  copyFileSync(join(SRC_DIR, "manifest.json"), join(DIST_DIR, "manifest.json"));

  // Copy popup HTML and CSS
  copyFileSync(join(SRC_DIR, "popup", "popup.html"), join(DIST_DIR, "popup", "popup.html"));
  copyFileSync(join(SRC_DIR, "popup", "popup.css"), join(DIST_DIR, "popup", "popup.css"));

  // Copy content CSS
  copyFileSync(join(SRC_DIR, "content", "content.css"), join(DIST_DIR, "content", "content.css"));

  // Copy icons (if they exist)
  const iconsDir = join(SRC_DIR, "icons");
  if (existsSync(iconsDir)) {
    for (const file of readdirSync(iconsDir)) {
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
    entryPoints: [join(SRC_DIR, "popup", "popup.ts")],
    bundle: true,
    outfile: join(DIST_DIR, "popup", "popup.js"),
    format: "iife",
    target: "chrome100",
    minify: false, // Keep readable for debugging
    sourcemap: true,
  });
  console.log("✓ Bundled popup.js");

  // Bundle content script
  await build({
    entryPoints: [join(SRC_DIR, "content", "content.ts")],
    bundle: true,
    outfile: join(DIST_DIR, "content", "content.js"),
    format: "iife",
    target: "chrome100",
    minify: false,
    sourcemap: true,
  });
  console.log("✓ Bundled content.js");

  // Bundle background service worker
  await build({
    entryPoints: [join(SRC_DIR, "background", "background.ts")],
    bundle: true,
    outfile: join(DIST_DIR, "background", "background.js"),
    format: "esm", // Service workers use ES modules
    target: "chrome100",
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

  // Check if icons exist
  const icon16 = join(iconsDir, "icon16.png");
  if (!existsSync(icon16)) {
    // Create a simple SVG-based placeholder (will need real icons later)
    console.log("⚠ No icons found - extension will use default icon");
    console.log("  Add icons to src/chrome/icons/ (icon16.png, icon48.png, icon128.png)");
  }
}

/**
 * Main build function
 */
async function main(): Promise<void> {
  console.log("Building Agent Blame Chrome Extension...\n");

  try {
    clean();
    copyStatic();
    await bundle();
    createPlaceholderIcons();

    console.log("\n✓ Build complete!");
    console.log(`  Output: ${DIST_DIR}`);
    console.log("\nTo load in Chrome:");
    console.log("  1. Go to chrome://extensions");
    console.log("  2. Enable 'Developer mode'");
    console.log("  3. Click 'Load unpacked'");
    console.log(`  4. Select: ${DIST_DIR}`);
  } catch (error) {
    console.error("Build failed:", error);
    process.exit(1);
  }
}

main();
