import * as vscode from 'vscode';
import { getSettings } from '../core/settings';
import { neutralizeImages } from './markdownRenderer';
import { findBlockAt } from './taggedCommentScanner';
import { isCSharpDocument, type TaggedCommentService } from './taggedCommentService';

/** Longer bodies are cut in the hover; the preview shows everything. */
export const MAX_HOVER_CHARS = 20_000;

/**
 * Rich hover for `/*markdown` comments. The Markdown is untrusted: command links are disabled, raw HTML
 * is not rendered and, in Restricted Mode, image syntax is shown as links instead of loading images.
 */
export function registerTaggedCommentHover(service: TaggedCommentService): vscode.Disposable {
  return vscode.languages.registerHoverProvider(
    [{ language: 'csharp' }, { pattern: '**/*.cs' }],
    {
      provideHover(document, position) {
        if (!isCSharpDocument(document) || !getSettings(document.uri).comments.markdownHover) {
          return undefined;
        }
        const offset = document.offsetAt(position);
        const block = findBlockAt(service.getScan(document), offset);
        if (!block || !block.descriptor.hover || offset >= block.endOffset) {
          return undefined;
        }
        let body = block.normalizedBody;
        if (body.trim() === '') {
          return undefined;
        }
        if (body.length > MAX_HOVER_CHARS) {
          body = `${body.slice(0, MAX_HOVER_CHARS)}\n\n*${vscode.l10n.t('(truncated — open the tagged comment preview to see everything)')}*`;
        }
        if (!vscode.workspace.isTrusted) {
          body = neutralizeImages(body);
        }
        const content = new vscode.MarkdownString(body, false);
        content.isTrusted = false;
        content.supportHtml = false;
        const range = new vscode.Range(document.positionAt(block.startOffset), document.positionAt(block.endOffset));
        return new vscode.Hover(content, range);
      },
    },
  );
}
