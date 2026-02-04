/**
 * Browser API compatibility layer
 *
 * Provides a unified API that works in both Chrome and Firefox.
 * Firefox uses the `browser` namespace, Chrome uses `chrome`.
 * Both have identical APIs for the features we use.
 */

// biome-ignore lint: browser is defined in Firefox extensions
declare const browser: typeof chrome;

export const api: typeof chrome =
  typeof browser !== "undefined" ? browser : chrome;
