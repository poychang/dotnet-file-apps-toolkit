import * as assert from 'node:assert/strict';
import { CodeHighlighter } from '../../src/comments/codeHighlighter';
import { markdownDecorationRanges } from '../../src/comments/markdownSyntax';
import { createMarkdownRenderer, neutralizeImages } from '../../src/comments/markdownRenderer';
import { parsePreviewMessage, renderPreview, type PreviewLabels } from '../../src/comments/previewHtml';
import { analyzeStructuredBlock } from '../../src/comments/structuredData';
import { mapTokensToSource } from '../../src/comments/syntaxGrammarAdapter';
import { scanTaggedComments } from '../../src/comments/taggedCommentScanner';

const labels: PreviewLabels = {
  lines: (a, b) => `L${a}-${b}`,
  goToSource: 'Go',
  copy: 'Copy',
  copyTitle: 'Copy body',
  unterminated: 'Unterminated',
  empty: 'No tagged comments',
  emptyHint: '/*markdown */',
  emptyBody: '(empty)',
  renderFailed: (r) => `Failed: ${r}`,
  tooLarge: 'Too large',
  noHighlighter: 'No highlighter',
  truncated: (n) => `First ${n}`,
  structurePreview: 'Structure preview',
  validationIssues: (count) => `Validation found ${count} issue(s).`,
};

describe('markdown rendering', () => {
  const render = createMarkdownRenderer({ allowRemoteImages: false });

  it('renders rich Markdown', () => {
    const html = render('# Title\n\n**bold** and `code`\n\n| a | b |\n|:-:|--:|\n| 1 | 2 |\n\n- item');
    assert.match(html, /<h1>Title<\/h1>/);
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<th class="align-center">a<\/th>/);
    assert.match(html, /<td class="align-right">2<\/td>/);
    assert.match(html, /<li>item<\/li>/);
    assert.doesNotMatch(html, /style=/);
  });

  it('escapes raw HTML and drops unsafe link schemes', () => {
    const html = render(
      '<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>\n\n[cmd](command:workbench.action.quit) [js](javascript:alert(1)) [file](file:///etc/passwd) [ok](https://example.com)',
    );
    assert.doesNotMatch(html, /<script|<img/);
    assert.match(html, /&lt;script&gt;/);
    assert.doesNotMatch(html, /href="(command|javascript|file):/);
    assert.match(html, /<a href="https:\/\/example.com" rel="noopener noreferrer">ok<\/a>/);
  });

  it('only shows https images when remote images are allowed', () => {
    const md = '![logo](https://example.com/a.png) ![local](http://example.com/b.png)';
    const blocked = render(md);
    assert.doesNotMatch(blocked, /<img/);
    assert.match(blocked, /<span class="md-image-blocked" title="https:\/\/example.com\/a.png">logo<\/span>/);

    const allowed = createMarkdownRenderer({ allowRemoteImages: true })(md);
    assert.match(allowed, /<img src="https:\/\/example.com\/a.png" alt="logo" loading="lazy" referrerpolicy="no-referrer">/);
    assert.match(allowed, /class="md-image-blocked" title="http:\/\/example.com\/b.png"/);
  });

  it('neutralizes image syntax outside code for hovers', () => {
    const md = '![a](https://x/y.png) `![b](c)`\n```\n![c](d)\n```\n';
    assert.equal(neutralizeImages(md), '\\![a](https://x/y.png) `![b](c)`\n```\n![c](d)\n```\n');
  });
});

describe('code highlighting and preview HTML', function () {
  this.timeout(30000);
  let highlighter: CodeHighlighter;

  before(async () => {
    highlighter = await CodeHighlighter.create();
  });

  it('loads the supported preview grammars and emits class-based colors', () => {
    for (const lang of [
      'markdown',
      'yaml',
      'json',
      'sql',
      'xml',
      'shellscript',
      'powershell',
      'csharp',
      'javascript',
      'typescript',
      'html',
      'css',
      'python',
      'cpp',
      'toml',
      'ini',
      'docker',
      'csv',
    ]) {
      assert.equal(highlighter.supports(lang), true, lang);
    }
    assert.equal(highlighter.supports('not-a-supported-language'), false);
    const lines = highlighter.tokenize('port: 8080 # <b>', 'yaml')!;
    const classed = lines[0].filter((t) => t.classes);
    assert.ok(classed.length >= 3);
    assert.ok(classed.every((t) => /^(l\d+ ?|d\d+ ?|f[ibu] ?)+$/.test(t.classes)), JSON.stringify(classed));
    assert.match(highlighter.css, /body\.vscode-light \.l0/);
    assert.match(highlighter.highlightToHtml('<a/>', 'xml')!, /&#60;/);
    assert.ok(highlighter.highlightToHtml('const x: number = 1;', 'typescript')!.includes('class='));
    assert.match(highlighter.highlightToHtml('~~gone~~', 'markdown')!, /class="[^"]*\bfs\b/, 'strikethrough class');
  });

  it('renders each block with its own strategy and source line numbers', () => {
    const text = [
      'Console.WriteLine();',
      '/*markdown',
      '# Read me',
      '*/',
      '/*yaml',
      'key: <value>',
      '*/',
      '/*json',
      '*/',
      '/*sql',
      'SELECT 1;',
    ].join('\n');
    const markdown = createMarkdownRenderer({ allowRemoteImages: false });
    const { html, blocks } = renderPreview(scanTaggedComments(text), { labels, markdown, highlighter });
    assert.deepEqual(
      blocks.map((b) => [b.language, b.renderer]),
      [
        ['markdown', 'markdown'],
        ['yaml', 'highlight'],
        ['json', 'plain'],
        ['sql', 'highlight'],
      ],
    );
    assert.match(blocks[0].html, /<h1>Read me<\/h1>/);
    assert.match(blocks[1].html, /data-line="0">6<\/span>/);
    assert.match(blocks[1].html, /&#60;value&#62;/);
    assert.doesNotMatch(html, /<value>/);
    assert.match(blocks[2].html, /\(empty\)/);
    assert.match(blocks[3].html, /Unterminated/);
    assert.match(blocks[1].html, /L5-7/);
  });

  it('falls back to escaped plain text when rendering fails or the body is too large', () => {
    const scan = scanTaggedComments('/*markdown\n<b>x</b>\n*/\n/*yaml\nk: v\n*/');
    const failing = renderPreview(scan, {
      labels,
      markdown: () => {
        throw new Error('boom');
      },
      highlighter,
      maxChars: 3,
    });
    assert.match(failing.blocks[0].html, /Too large/);
    assert.match(failing.blocks[0].html, /&#60;b&#62;x&#60;\/b&#62;/);

    const broken = renderPreview(scan, {
      labels,
      markdown: () => {
        throw new Error('boom');
      },
    });
    assert.match(broken.blocks[0].html, /Failed: boom/);
    assert.deepEqual(
      broken.blocks.map((b) => b.renderer),
      ['plain', 'plain'],
    );
    assert.match(broken.blocks[1].html, /No highlighter/);
  });

  it('shows guidance when no tagged comments exist', () => {
    const { html, blocks } = renderPreview(scanTaggedComments('/** doc */'), { labels, markdown: (s) => s });
    assert.equal(blocks.length, 0);
    assert.match(html, /No tagged comments/);
  });

  it('maps themed tokens of an indented CRLF body back to document ranges for editor decorations', () => {
    const text = 'var a = 1;\r\n    /*yaml\r\n    name: "demo" # note\r\n    port: 8080\r\n    */\r\nvar b = 2;';
    const [block] = scanTaggedComments(text).blocks;
    const spans = mapTokensToSource(block.lineMap, highlighter.tokenizeStyles(block.normalizedBody, 'yaml')!);
    const found = spans.map((s) => [text.slice(s.start, s.end), s.style.dark, s.style.light]);
    assert.deepEqual(found, [
      ['name', '#569CD6', '#800000'],
      ['"demo"', '#CE9178', '#A31515'],
      ['# note', '#6A9955', '#008000'],
      ['port', '#569CD6', '#800000'],
      ['8080', '#B5CEA8', '#098658'],
    ]);
    assert.ok(spans.every((s) => s.start >= block.bodyStartOffset && s.end <= block.bodyEndOffset));
  });

  it('colors Markdown bodies like VS Code and paints default text with the editor foreground', () => {
    const text = [
      '/*markdown',
      '  # Title',
      '  Some **bold**, *italic*, ~~gone~~ and `code`.',
      '  - [link](https://example.com)',
      '  > quote',
      '  Tag <b>x</b>',
      '  ```json',
      '  { "a": 1 }',
      '  ```',
      '*/',
    ].join('\n');
    const [block] = scanTaggedComments(text).blocks;
    const spans = mapTokensToSource(block.lineMap, highlighter.tokenizeStyles(block.normalizedBody, 'markdown', true)!);
    const styleOf = (source: string) => spans.find((s) => text.slice(s.start, s.end) === source)?.style;

    assert.deepEqual(styleOf('# Title'), { light: '#800000', dark: '#569CD6', fontStyle: 2 });
    assert.deepEqual(styleOf('**bold**'), { light: '#000080', dark: '#569CD6', fontStyle: 2 });
    assert.equal(styleOf('`code`')?.dark, '#CE9178');
    assert.equal(styleOf('-')?.dark, '#6796E6');
    assert.equal(styleOf('>')?.dark, '#6A9955');
    assert.equal(styleOf('~~gone~~')?.fontStyle, 8);
    assert.equal(styleOf('https://example.com')?.fontStyle, 4);
    assert.equal(styleOf('b')?.dark, '#569CD6', 'inline HTML tag name');
    assert.equal(styleOf('"a"')?.dark, '#9CDCFE', 'fenced JSON');

    for (const plain of ['Some ', ' and ', ' quote']) {
      const style = styleOf(plain);
      assert.ok(style?.foreground, `"${plain}" is painted with the editor foreground`);
      assert.equal(style.light ?? style.dark, undefined);
    }
    const italic = styleOf('*italic*');
    assert.deepEqual([italic?.fontStyle, italic?.foreground], [1, true]);

    // Without painting, default text is left out like it is for code bodies.
    const unpainted = mapTokensToSource(block.lineMap, highlighter.tokenizeStyles(block.normalizedBody, 'markdown')!);
    assert.ok(unpainted.length > 0 && unpainted.every((s) => !s.style.foreground));
    assert.ok(!unpainted.some((s) => ['Some ', ' and ', ' quote'].includes(text.slice(s.start, s.end))));
  });
});

describe('structured data validation', () => {
  it('validates YAML and JSON and builds bounded structure outlines without scalar values', () => {
    const scan = scanTaggedComments(
      ['/*yaml', 'app:', '  name: sample', '*/', '/*json', '{"enabled": true}', '*/'].join('\n'),
    );
    const yaml = analyzeStructuredBlock(scan.blocks[0]);
    const json = analyzeStructuredBlock(scan.blocks[1]);

    assert.deepEqual(yaml.issues, []);
    assert.equal(yaml.structure?.kind, 'object');
    assert.equal(yaml.structure?.children?.[0].label, 'app');
    assert.deepEqual(json.issues, []);
    assert.equal(json.structure?.children?.[0].label, 'enabled');

    const { html } = renderPreview(scan, {
      labels,
      markdown: (source) => source,
      structuredData: new Map(scan.blocks.map((block) => [block.index, analyzeStructuredBlock(block)])),
    });
    assert.match(html, /Structure preview/);
    assert.match(html, /<code>enabled<\/code>/);
    assert.doesNotMatch(html, /<code>true<\/code>/);
  });

  it('reports malformed YAML/JSON with source offsets and does not create structures', () => {
    const scan = scanTaggedComments(['/*yaml', 'name: [', '*/', '/*json', '{"enabled": }', '*/'].join('\n'));
    const yaml = analyzeStructuredBlock(scan.blocks[0]);
    const json = analyzeStructuredBlock(scan.blocks[1]);

    assert.ok(yaml.issues.length > 0);
    assert.ok(yaml.issues[0].offset > 0);
    assert.equal(yaml.structure, undefined);
    assert.ok(json.issues.length > 0);
    assert.ok(json.issues[0].offset > 0);
    assert.equal(json.structure, undefined);
  });
});

describe('parsePreviewMessage', () => {
  it('accepts only well-formed messages', () => {
    assert.deepEqual(parsePreviewMessage({ type: 'ready' }), { type: 'ready' });
    assert.deepEqual(parsePreviewMessage({ type: 'reveal', block: 2, line: 0 }), { type: 'reveal', block: 2, line: 0 });
    assert.deepEqual(parsePreviewMessage({ type: 'copy', block: 0, extra: 'x' }), { type: 'copy', block: 0 });
    for (const bad of [
      null,
      'reveal',
      { type: 'reveal', block: -1 },
      { type: 'reveal', block: 1.5 },
      { type: 'reveal', block: '1' },
      { type: 'reveal', block: 1, line: 'x' },
      { type: 'command', command: 'workbench.action.quit' },
      { type: 'copy' },
    ]) {
      assert.equal(parsePreviewMessage(bad), undefined, JSON.stringify(bad));
    }
  });
});

describe('markdownDecorationRanges', () => {
  it('finds headings, markers, emphasis, code and links at document offsets', () => {
    const text = [
      '/*markdown',
      '  # Title',
      '  - **bold** and *it* or _it_ with `**not bold**`',
      '  > [link](https://example.com)',
      '  ```yaml',
      '  # not a heading',
      '  ```',
      '  1. snake_case_word',
      '*/',
    ].join('\n');
    const [block] = scanTaggedComments(text).blocks;
    const found = markdownDecorationRanges(block.lineMap).map((r) => [r.kind, text.slice(r.start, r.end)]);
    assert.deepEqual(found, [
      ['bold', '# Title'],
      ['bold', '-'],
      ['code', '`**not bold**`'],
      ['bold', '**bold**'],
      ['italic', '*it*'],
      ['italic', '_it_'],
      ['bold', '>'],
      ['link', '[link](https://example.com)'],
      ['code', '```yaml'],
      ['code', '# not a heading'],
      ['code', '```'],
      ['bold', '1.'],
    ]);
  });
});
