import * as vscode from 'vscode';
import { COMMANDS } from '../commands/registerCommands';
import { getSettings } from '../core/settings';
import { prepareHoverMarkdown } from './hoverMarkdown';
import { neutralizeImages } from './markdownRenderer';
import { findBlockAt } from './taggedCommentScanner';
import { isCSharpDocument, type TaggedCommentService } from './taggedCommentService';

/** Longer bodies are cut in the hover; the preview shows everything. */
export const MAX_HOVER_CHARS = 20_000;

/**
 * Rich hover for `/*markdown` comments. The Markdown is untrusted: command links are disabled, raw HTML
 * is not rendered and, in Restricted Mode, image syntax is shown as links instead of loading images.
 * A separate hover part links to the preview; it is the only command a hover link can run.
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
        const content = new vscode.MarkdownString(prepareHoverMarkdown(body), false);
        // Trusted only so VS Code keeps the quote bar `<span>` tags; no command link in the comment can run.
        content.isTrusted = { enabledCommands: [] };
        content.supportHtml = false;
        const args = encodeURIComponent(JSON.stringify([document.uri])).replace(/[()]/g, (c) => `%${c.charCodeAt(0).toString(16)}`);
        const previewLink = new vscode.MarkdownString(`[${vscode.l10n.t('Preview Tagged Comments')}](command:${COMMANDS.previewComments}?${args})`);
        previewLink.isTrusted = { enabledCommands: [COMMANDS.previewComments] };
        const range = new vscode.Range(document.positionAt(block.startOffset), document.positionAt(block.endOffset));
        return new vscode.Hover([content, previewLink], range);
      },
    },
  );
}
