const MARKDOWN_SOURCE_BLOCK_RE = /```(?:md|markdown)\s*\n([\s\S]*?)```/gi;
const FENCED_CODE_BLOCK_RE = /```[^\n]*\n[\s\S]*?```/g;
const INLINE_CODE_RE = /`([^`\n]+)`/g;
const LINK_RE = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g;

const PLACEHOLDER_START = "\uE000";
const PLACEHOLDER_END = "\uE001";

function unwrapMarkdownSourceBlocks(text: string): string {
  return text.replace(MARKDOWN_SOURCE_BLOCK_RE, (_, content: string) =>
    content.trim(),
  );
}

function escapeHtml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function escapeHtmlAttribute(text: string): string {
  return escapeHtml(text).replace(/"/g, "&quot;");
}

function protect(
  text: string,
  pattern: RegExp,
  placeholders: string[],
  render: (match: string, ...groups: string[]) => string,
): string {
  const nextText = text.replace(pattern, (...args) => {
    const match = args[0] as string;
    const groups = args.slice(1, -2) as string[];
    const token = `${PLACEHOLDER_START}${placeholders.length}${PLACEHOLDER_END}`;
    placeholders.push(render(match, ...groups));
    return token;
  });
  return nextText;
}

function restore(text: string, placeholders: string[]): string {
  return text.replace(
    new RegExp(`${PLACEHOLDER_START}(\\d+)${PLACEHOLDER_END}`, "g"),
    (_, index: string) => placeholders[Number(index)] ?? "",
  );
}

function formatSlackInline(text: string): string {
  let formatted = text;

  formatted = formatted.replace(LINK_RE, (_, label: string, url: string) => {
    return `<${url}|${label}>`;
  });
  formatted = formatted.replace(
    /^(#{1,6})[ \t]+(.+)$/gm,
    (_, __: string, content: string) => `*${content.trim()}*`,
  );
  formatted = formatted.replace(/\*\*([^*\n]+)\*\*/g, "*$1*");
  formatted = formatted.replace(/__([^_\n]+)__/g, "*$1*");

  return formatted;
}

function formatTelegramInline(text: string): string {
  let formatted = escapeHtml(text);

  formatted = formatted.replace(LINK_RE, (_, label: string, url: string) => {
    return `<a href="${escapeHtmlAttribute(url)}">${escapeHtml(label)}</a>`;
  });
  formatted = formatted.replace(
    /^(#{1,6})[ \t]+(.+)$/gm,
    (_, __: string, content: string) => `<b>${content.trim()}</b>`,
  );
  formatted = formatted.replace(/\*\*([^*\n]+)\*\*/g, "<b>$1</b>");
  formatted = formatted.replace(/__([^_\n]+)__/g, "<b>$1</b>");
  formatted = formatted.replace(
    /(^|[^\w<])\*([^*\n]+)\*(?=[^\w>]|$)/g,
    "$1<i>$2</i>",
  );
  formatted = formatted.replace(
    /(^|[^\w<])_([^_\n]+)_(?=[^\w>]|$)/g,
    "$1<i>$2</i>",
  );
  formatted = formatted.replace(/^(?:-|\*) /gm, "• ");

  return formatted;
}

export function formatSlackMessage(text: string): string {
  const unwrapped = unwrapMarkdownSourceBlocks(text);
  const placeholders: string[] = [];
  const withFenced = protect(
    unwrapped,
    FENCED_CODE_BLOCK_RE,
    placeholders,
    (block: string) => block,
  );
  const withInline = protect(
    withFenced,
    INLINE_CODE_RE,
    placeholders,
    (_match: string, code: string) => `\`${code}\``,
  );

  return restore(formatSlackInline(withInline), placeholders);
}

export function formatTelegramMessage(text: string): string {
  const unwrapped = unwrapMarkdownSourceBlocks(text);
  const placeholders: string[] = [];
  const withFenced = protect(
    unwrapped,
    FENCED_CODE_BLOCK_RE,
    placeholders,
    (block: string) => {
      const content = block
        .replace(/^```[^\n]*\n/, "")
        .replace(/\n```$/, "");
      return `<pre><code>${escapeHtml(content)}</code></pre>`;
    },
  );
  const withInline = protect(
    withFenced,
    INLINE_CODE_RE,
    placeholders,
    (_match: string, code: string) => `<code>${escapeHtml(code)}</code>`,
  );

  return restore(formatTelegramInline(withInline), placeholders);
}
