import * as assert from 'node:assert/strict';
import { displayWidth, MAX_HOVER_TABLE_WIDTH, prepareHoverMarkdown, QUOTE_BAR } from '../../src/comments/hoverMarkdown';

describe('prepareHoverMarkdown', () => {
  it('draws tables as aligned box text with plain cell text', () => {
    const md = 'Intro\n| Option | 預設值 | Note |\n|:--|--:|:-:|\n| `strict` | true | **b** [x](https://y) |\n| 中文 |\n\nAfter';
    assert.equal(
      prepareHoverMarkdown(md),
      [
        'Intro',
        '```text',
        '┌────────┬────────┬──────┐',
        '│ Option │ 預設值 │ Note │',
        '├────────┼────────┼──────┤',
        '│ strict │   true │ b x  │',
        '│ 中文   │        │      │',
        '└────────┴────────┴──────┘',
        '```',
        '',
        'After',
      ].join('\n'),
    );
  });

  it('keeps tables that would be too wide for the hover', () => {
    const md = `| ${'x'.repeat(MAX_HOVER_TABLE_WIDTH)} |\n|---|\n| 1 |`;
    assert.equal(prepareHoverMarkdown(md), md);
  });

  it('gives each line of a paragraph quote a bar and a hard break', () => {
    const md = 'Para\n> first  \nlazy\n>\n> second\n# Next\n> - list stays native\n';
    assert.equal(
      prepareHoverMarkdown(md),
      ['Para', '', `${QUOTE_BAR}first  `, `${QUOTE_BAR}lazy`, '', `${QUOTE_BAR}second`, '', '# Next', '> - list stays native', ''].join('\n'),
    );
  });

  it('removes raw span tags outside code only', () => {
    const md = 'a <span style="color:#f00">red</span> `<span>`\n\n    <span>indented</span>\n\n```\n<span>fenced</span>\n```';
    assert.equal(
      prepareHoverMarkdown(md),
      'a red `<span>`\n\n    <span>indented</span>\n\n```\n<span>fenced</span>\n```',
    );
  });

  it('counts wide characters as two columns and combining marks as none', () => {
    assert.equal(displayWidth('ab中文😀e\u0301'), 9);
  });
});
