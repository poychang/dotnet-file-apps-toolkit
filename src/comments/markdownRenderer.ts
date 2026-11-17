import MarkdownIt from 'markdown-it';

export interface MarkdownRenderOptions {
  /** Allow `https:` images. Other image sources are always replaced by their alt text. */
  readonly allowRemoteImages: boolean;
  /** Returns highlighted `<pre>` HTML for a fenced code block, or undefined to fall back to escaped text. */
  readonly highlight?: (code: string, language: string) => string | undefined;
}

const SAFE_LINK_RE = /^(https?:\/\/|mailto:)/i;

export function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/**
 * Creates a Markdown-to-HTML renderer for untrusted comment content: raw HTML is escaped, only
 * `http(s)`/`mailto` links survive, inline `style` attributes are never emitted (strict CSP) and remote
 * images are opt-in.
 */
export function createMarkdownRenderer(options: MarkdownRenderOptions): (source: string) => string {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
    highlight: (code, lang) => {
      const language = lang.trim().split(/\s+/)[0] ?? '';
      if (!language || !options.highlight) {
        return '';
      }
      return options.highlight(code, language) ?? '';
    },
  });
  md.validateLink = (url) => SAFE_LINK_RE.test(url.trim());

  md.core.ruler.push('dfat_align_classes', (state) => {
    for (const token of state.tokens) {
      if (token.type === 'th_open' || token.type === 'td_open') {
        const style = token.attrGet('style');
        if (style) {
          const align = /text-align:\s*(left|center|right)/.exec(String(style))?.[1];
          token.attrs = (token.attrs ?? []).filter(([name]) => name !== 'style');
          if (align) {
            token.attrJoin('class', `align-${align}`);
          }
        }
      }
    }
  });

  const renderToken = md.renderer.renderToken.bind(md.renderer);
  md.renderer.rules.link_open = (tokens, idx, opts, _env, self) => {
    tokens[idx].attrSet('rel', 'noopener noreferrer');
    return self.renderToken(tokens, idx, opts);
  };
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const src = String(token.attrGet('src') ?? '');
    const alt = self.renderInlineAsText(token.children ?? [], opts, env);
    if (options.allowRemoteImages && /^https:\/\//i.test(src)) {
      token.attrSet('alt', alt);
      token.attrSet('loading', 'lazy');
      token.attrSet('referrerpolicy', 'no-referrer');
      return renderToken(tokens, idx, opts);
    }
    return `<span class="md-image-blocked" title="${escapeHtml(src)}">${escapeHtml(alt || src)}</span>`;
  };

  return (source) => md.render(source);
}

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})/;
const CODE_SPAN_RE = /(`+)(?!`)[^\n]*?[^`\n]\1(?!`)/g;

/**
 * Turns Markdown image syntax (`![alt](src)`) into plain links outside code, so content shown in a
 * native hover cannot make VS Code fetch remote images (used in untrusted workspaces).
 */
export function neutralizeImages(markdown: string): string {
  let fence: string | undefined;
  return markdown
    .split('\n')
    .map((line) => {
      const f = FENCE_RE.exec(line);
      if (fence) {
        if (f && f[1][0] === fence[0] && f[1].length >= fence.length) {
          fence = undefined;
        }
        return line;
      }
      if (f) {
        fence = f[1];
        return line;
      }
      return replaceOutsideCodeSpans(line, (text) => text.replace(/!\[/g, '\\!['));
    })
    .join('\n');
}

/** Applies `replace` to the parts of one Markdown line that are outside code spans. */
export function replaceOutsideCodeSpans(line: string, replace: (text: string) => string): string {
  let out = '';
  let last = 0;
  for (const m of line.matchAll(CODE_SPAN_RE)) {
    out += replace(line.slice(last, m.index)) + m[0];
    last = m.index + m[0].length;
  }
  return out + replace(line.slice(last));
}
