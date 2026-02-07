/**
 * Terminal color utilities with automatic detection
 */

/**
 * Check if the terminal supports colors
 */
function supportsColor(): boolean {
  // Respect NO_COLOR standard (https://no-color.org/)
  if (process.env.NO_COLOR !== undefined) {
    return false;
  }

  // Force color if FORCE_COLOR is set
  if (process.env.FORCE_COLOR !== undefined) {
    return true;
  }

  // Check if stdout is a TTY
  if (!process.stdout.isTTY) {
    return false;
  }

  // Check for dumb terminal
  if (process.env.TERM === "dumb") {
    return false;
  }

  return true;
}

const hasColor = supportsColor();

/**
 * Terminal color codes - automatically disabled for non-color terminals
 */
export const colors = {
  reset: hasColor ? "\x1b[0m" : "",
  bold: hasColor ? "\x1b[1m" : "",
  dim: hasColor ? "\x1b[2m" : "",
  red: hasColor ? "\x1b[31m" : "",
  green: hasColor ? "\x1b[32m" : "",
  yellow: hasColor ? "\x1b[33m" : "",
  blue: hasColor ? "\x1b[34m" : "",
  magenta: hasColor ? "\x1b[35m" : "",
  cyan: hasColor ? "\x1b[36m" : "",
  gray: hasColor ? "\x1b[90m" : "",
  orange: hasColor ? "\x1b[38;2;184;101;64m" : "",
};
