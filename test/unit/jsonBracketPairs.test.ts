import * as assert from 'node:assert/strict';
import type { BodyLine } from '../../src/comments/normalization';
import { jsonBracketPairTokens } from '../../src/comments/jsonBracketPairs';

function styled(lines: string[]) {
  const body: BodyLine[] = lines.map((text, sourceLine) => ({ sourceLine, sourceOffset: 0, text }));
  return jsonBracketPairTokens(body);
}

describe('jsonBracketPairTokens', () => {
  it('colors matched pairs by nesting depth and uses the editor foreground for separators', () => {
    const tokens = styled(['{"outer":[{"inner":1},2]}']);
    const styles = new Map(tokens[0].map((token) => [token.start, token.style]));
    assert.equal(styles.get(0)?.themeColor, 'editorBracketHighlight.foreground1');
    assert.equal(styles.get(9)?.themeColor, 'editorBracketHighlight.foreground2');
    assert.equal(styles.get(10)?.themeColor, 'editorBracketHighlight.foreground3');
    assert.equal(styles.get(20)?.themeColor, 'editorBracketHighlight.foreground3');
    assert.equal(styles.get(21)?.foreground, true);
    assert.equal(styles.get(23)?.themeColor, 'editorBracketHighlight.foreground2');
    assert.equal(styles.get(24)?.themeColor, 'editorBracketHighlight.foreground1');
    assert.equal(styles.get(8)?.foreground, true);
  });

  it('ignores delimiters inside escaped JSON strings and carries bracket depth across lines', () => {
    const tokens = styled(['{', '  "text": "quote: \\"{,}\\"",', '  "items": [1]', '}']);
    assert.deepEqual(tokens[1].map((token) => ['  "text": "quote: \\"{,}\\"",'.slice(token.start, token.end), token.style]), [
      [':', { fontStyle: 0, foreground: true }],
      [',', { fontStyle: 0, foreground: true }],
    ]);
    assert.equal(tokens[0][0].style.themeColor, 'editorBracketHighlight.foreground1');
    assert.equal(tokens[3][0].style.themeColor, 'editorBracketHighlight.foreground1');
    assert.ok(tokens[2].some((token) => token.style.themeColor === 'editorBracketHighlight.foreground2'));
  });

  it('leaves unmatched brackets in the editor foreground', () => {
    const tokens = styled(['{ [ }']);
    const bracketTokens = tokens[0].filter((token) => token.start === 0 || token.start === 2 || token.start === 4);
    assert.deepEqual(bracketTokens.map((token) => token.style.foreground), [true, true, true]);
  });

  it('respects disabled native bracket-pair colorization', () => {
    const tokens = jsonBracketPairTokens([{ sourceLine: 0, sourceOffset: 0, text: '{}' }], false);
    assert.deepEqual(tokens[0].map((token) => token.style.foreground), [true, true]);
  });

  it('skips bodies above the shared highlighting size limit', () => {
    const tokens = styled(['{'.padEnd(200_001, ' ')]);
    assert.deepEqual(tokens, [[]]);
  });
});
