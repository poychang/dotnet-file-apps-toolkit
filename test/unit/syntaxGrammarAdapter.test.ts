import * as assert from 'node:assert/strict';
import type { StyledToken, TokenStyle } from '../../src/comments/codeHighlighter';
import type { BodyLine } from '../../src/comments/normalization';
import { mapTokensToSource, overlayTokenStyles, styleKey } from '../../src/comments/syntaxGrammarAdapter';

const A: TokenStyle = { light: '#800000', dark: '#569CD6', fontStyle: 0 };
const B: TokenStyle = { dark: '#CE9178', fontStyle: 1 };

describe('mapTokensToSource', () => {
  const lineMap: BodyLine[] = [
    { sourceLine: 1, sourceOffset: 10, text: 'abcdef' },
    { sourceLine: 2, sourceOffset: 20, text: 'xy' },
  ];
  const lines: StyledToken[][] = [
    [
      { start: 0, end: 2, style: A },
      { start: 2, end: 4, style: { ...A } },
      { start: 4, end: 4, style: B },
      { start: 5, end: 6, style: B },
    ],
    [{ start: 0, end: 5, style: A }],
    [{ start: 0, end: 1, style: A }],
  ];

  it('merges adjacent tokens of the same style, clips to the line and offsets by the line map', () => {
    assert.deepEqual(
      mapTokensToSource(lineMap, lines).map((s) => [s.start, s.end, s.key]),
      [
        [10, 14, styleKey(A)],
        [15, 16, styleKey(B)],
        [20, 22, styleKey(A)],
      ],
    );
  });

  it('stops at the span limit', () => {
    assert.equal(mapTokensToSource(lineMap, lines, 2).length, 2);
  });

  it('keeps painted default text apart from unpainted styles with the same colors', () => {
    assert.notEqual(styleKey({ fontStyle: 1 }), styleKey({ fontStyle: 1, foreground: true }));
    assert.notEqual(styleKey({ fontStyle: 0, themeColor: 'editorBracketHighlight.foreground1' }), styleKey({ fontStyle: 0, themeColor: 'editorBracketHighlight.foreground2' }));
    assert.equal(styleKey(A), styleKey({ ...A }));
  });

  it('overlays styles without leaving the base range underneath', () => {
    const base: StyledToken[][] = [[{ start: 0, end: 5, style: A }]];
    const overrides: StyledToken[][] = [[{ start: 2, end: 3, style: { fontStyle: 0, themeColor: 'editorBracketHighlight.foreground1' } }]];
    assert.deepEqual(
      overlayTokenStyles(base, overrides)[0].map((t) => [t.start, t.end, t.style]),
      [
        [0, 2, A],
        [2, 3, { fontStyle: 0, themeColor: 'editorBracketHighlight.foreground1' }],
        [3, 5, A],
      ],
    );
  });
});
