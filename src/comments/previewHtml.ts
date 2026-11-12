import type { CodeHighlighter } from './codeHighlighter';
import { MAX_HIGHLIGHT_CHARS, tokensToHtml } from './codeHighlighter';
import { escapeHtml } from './markdownRenderer';
import type { TaggedCommentBlock, TaggedCommentScan } from './taggedCommentScanner';

export interface PreviewLabels {
  readonly lines: (start: number, end: number) => string;
  readonly goToSource: string;
  readonly copy: string;
  readonly copyTitle: string;
  readonly unterminated: string;
  readonly empty: string;
  readonly emptyHint: string;
  readonly emptyBody: string;
  readonly renderFailed: (reason: string) => string;
  readonly tooLarge: string;
  readonly noHighlighter: string;
  readonly truncated: (shown: number) => string;
}

export interface PreviewRenderContext {
  readonly labels: PreviewLabels;
  readonly markdown: (source: string) => string;
  readonly highlighter?: CodeHighlighter;
  /** Defaults to MAX_HIGHLIGHT_CHARS. */
  readonly maxChars?: number;
}

export interface RenderedBlock {
  readonly index: number;
  readonly language: string;
  readonly html: string;
  /** How the body was rendered; `plain` means escaped text fallback. */
  readonly renderer: 'markdown' | 'highlight' | 'plain';
}

function plainLines(block: TaggedCommentBlock): string {
  return block.lineMap.map((line, i) => lineHtml(block, i, escapeHtml(line.text))).join('\n');
}

function lineHtml(block: TaggedCommentBlock, i: number, content: string): string {
  const n = block.lineMap[i].sourceLine + 1;
  return `<span class="line"><span class="ln" aria-hidden="true" data-action="reveal" data-block="${block.index}" data-line="${i}">${n}</span><span class="lc">${content}</span></span>`;
}

function codeHtml(block: TaggedCommentBlock, body: string, plain: boolean): string {
  const lang = escapeHtml(block.language);
  return `<pre class="code${plain ? ' plain' : ''}" data-lang="${lang}"><code>${body}</code></pre>`;
}

function renderBody(block: TaggedCommentBlock, ctx: PreviewRenderContext): { html: string; renderer: RenderedBlock['renderer'] } {
  const { labels } = ctx;
  if (block.lineMap.length === 0 || block.normalizedBody.trim() === '') {
    return { html: `<p class="note">${escapeHtml(labels.emptyBody)}</p>`, renderer: 'plain' };
  }
  if (block.normalizedBody.length > (ctx.maxChars ?? MAX_HIGHLIGHT_CHARS)) {
    return { html: `<p class="note">${escapeHtml(labels.tooLarge)}</p>${codeHtml(block, plainLines(block), true)}`, renderer: 'plain' };
  }
  try {
    if (block.mode === 'document') {
      return { html: `<div class="markdown-body">${ctx.markdown(block.normalizedBody)}</div>`, renderer: 'markdown' };
    }
    const language = block.descriptor.previewLanguage;
    const tokens = language && ctx.highlighter ? ctx.highlighter.tokenize(block.normalizedBody, language) : undefined;
    if (!tokens) {
      return { html: `<p class="note">${escapeHtml(labels.noHighlighter)}</p>${codeHtml(block, plainLines(block), true)}`, renderer: 'plain' };
    }
    const body = block.lineMap.map((_, i) => lineHtml(block, i, tokensToHtml(tokens[i] ?? []))).join('\n');
    return { html: codeHtml(block, body, false), renderer: 'highlight' };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      html: `<p class="note error">${escapeHtml(labels.renderFailed(reason))}</p>${codeHtml(block, plainLines(block), true)}`,
      renderer: 'plain',
    };
  }
}

export function renderBlock(block: TaggedCommentBlock, ctx: PreviewRenderContext): RenderedBlock {
  const { labels } = ctx;
  const i = block.index;
  const body = renderBody(block, ctx);
  const header = [
    `<span class="badge" id="block-${i}-title">${escapeHtml(block.descriptor.displayName)}</span>`,
    `<button type="button" class="link" data-action="reveal" data-block="${i}" title="${escapeHtml(labels.goToSource)}">${escapeHtml(labels.lines(block.startLine + 1, block.endLine + 1))}</button>`,
    block.terminated ? '' : `<span class="warning">${escapeHtml(labels.unterminated)}</span>`,
    '<span class="spacer"></span>',
    `<button type="button" data-action="copy" data-block="${i}" title="${escapeHtml(labels.copyTitle)}">${escapeHtml(labels.copy)}</button>`,
  ].join('');
  const html =
    `<section class="block mode-${block.mode}" id="block-${i}" data-block="${i}" aria-labelledby="block-${i}-title">` +
    `<header class="block-header">${header}</header>` +
    `<div class="block-body">${body.html}</div></section>`;
  return { index: i, language: block.language, html, renderer: body.renderer };
}

export function renderPreview(scan: TaggedCommentScan, ctx: PreviewRenderContext): { html: string; blocks: RenderedBlock[] } {
  const { labels } = ctx;
  if (scan.blocks.length === 0) {
    return {
      html: `<div class="empty"><p>${escapeHtml(labels.empty)}</p><pre class="code plain"><code>${escapeHtml(labels.emptyHint)}</code></pre></div>`,
      blocks: [],
    };
  }
  const blocks = scan.blocks.map((b) => renderBlock(b, ctx));
  const notice = scan.truncated ? `<p class="note">${escapeHtml(labels.truncated(scan.blocks.length))}</p>` : '';
  return { html: notice + blocks.map((b) => b.html).join('\n'), blocks };
}

/** Messages the preview webview may send. Anything else is ignored. */
export type PreviewMessage =
  | { readonly type: 'ready' }
  | { readonly type: 'reveal'; readonly block: number; readonly line?: number }
  | { readonly type: 'copy'; readonly block: number };

function isIndex(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Validates an untrusted message from the webview. */
export function parsePreviewMessage(raw: unknown): PreviewMessage | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }
  const m = raw as Record<string, unknown>;
  switch (m.type) {
    case 'ready':
      return { type: 'ready' };
    case 'reveal':
      if (isIndex(m.block) && (m.line === undefined || isIndex(m.line))) {
        return m.line === undefined ? { type: 'reveal', block: m.block } : { type: 'reveal', block: m.block, line: m.line };
      }
      return undefined;
    case 'copy':
      return isIndex(m.block) ? { type: 'copy', block: m.block } : undefined;
    default:
      return undefined;
  }
}
