/**
 * Format markdown text for IRC.
 *
 * IRC doesn't support markdown, so we strip most formatting.
 * We convert bold to IRC bold (\x02) and collapse code blocks.
 */

/**
 * Format markdown text for IRC output.
 *
 * - **bold** → IRC bold (\x02...\x02)
 * - *italic* → plain text
 * - `code` → plain text
 * - Code blocks → collapsed
 * - Links → URL only
 */
export function formatForIrc(text: string): string {
  let result = text;

  // Remove code blocks entirely (they're too noisy for IRC)
  result = result.replace(/```[\s\S]*?```/g, '[code]');

  // Remove inline code backticks
  result = result.replace(/`([^`]+)`/g, '$1');

  // Convert **bold** to IRC bold (\x02...\x02)
  result = result.replace(/\*\*([^*]+)\*\*/g, '\x02$1\x02');

  // Remove *italic* (no good IRC equivalent)
  result = result.replace(/\*([^*]+)\*/g, '$1');

  // Remove _underline_ (IRC underline is \x1F but it's often not rendered well)
  result = result.replace(/_([^_]+)_/g, '$1');

  // Remove markdown links, keep URL
  result = result.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$2');

  // Remove image syntax ![alt](url)
  result = result.replace(/!\[([^\]]*)\]\([^)]+\)/g, '');

  // IRC lines must not contain embedded newlines; flatten all line breaks.
  result = result.replace(/\r?\n+/g, ' ');

  // Collapse repeated whitespace introduced by formatting removal.
  result = result.replace(/[ \t]{2,}/g, ' ');

  return result.trim();
}

/**
 * Strip all markdown formatting for plain text.
 *
 * More aggressive than formatForIrc — removes everything.
 */
export function stripMarkdown(text: string): string {
  let result = text;

  // Remove code blocks
  result = result.replace(/```[\s\S]*?```/g, '');

  // Remove inline code
  result = result.replace(/`([^`]+)`/g, '$1');

  // Remove bold/italic
  result = result.replace(/\*\*([^*]+)\*\*/g, '$1');
  result = result.replace(/\*([^*]+)\*/g, '$1');
  result = result.replace(/_([^_]+)_/g, '$1');

  // Remove links, keep text
  result = result.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');

  // Remove images
  result = result.replace(/!\[[^\]]*\]\([^)]+\)/g, '');

  return result.trim();
}
