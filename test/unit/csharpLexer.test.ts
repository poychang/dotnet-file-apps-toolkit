import * as assert from 'node:assert/strict';
import { lexCSharp, maskNonCode, type CSharpToken } from '../../src/csharp/csharpLexer';

function kinds(text: string): Array<[CSharpToken['kind'], string]> {
  return lexCSharp(text).map((t) => [t.kind, text.slice(t.start, t.end)]);
}

describe('csharpLexer', () => {
  it('recognizes line, block and doc comments', () => {
    const src = '// a\n/* b */ x /** c */\n/// d';
    assert.deepEqual(kinds(src), [
      ['lineComment', '// a'],
      ['blockComment', '/* b */'],
      ['blockComment', '/** c */'],
      ['lineComment', '/// d'],
    ]);
  });

  it('ends a block comment at the first */ (no nesting)', () => {
    const src = '/* outer /* inner */ code */';
    const tokens = lexCSharp(src);
    assert.equal(tokens.length, 1);
    assert.equal(src.slice(tokens[0].start, tokens[0].end), '/* outer /* inner */');
  });

  it('marks unterminated block comments', () => {
    const tokens = lexCSharp('x; /*markdown\n# Title');
    assert.equal(tokens.length, 1);
    assert.equal(tokens[0].kind, 'blockComment');
    assert.equal(tokens[0].terminated, false);
  });

  it('does not treat comment markers inside regular strings as comments', () => {
    assert.deepEqual(kinds('var s = "/*json\\n{}\\n*/"; // tail'), [
      ['string', '"/*json\\n{}\\n*/"'],
      ['lineComment', '// tail'],
    ]);
  });

  it('handles verbatim strings with doubled quotes spanning lines', () => {
    const src = 'var s = @"a ""/*x*/""\n/*y*/";';
    assert.deepEqual(kinds(src), [['string', '@"a ""/*x*/""\n/*y*/"']]);
  });

  it('handles raw string literals', () => {
    const src = 'var s = """\n  /*markdown\n  # nope\n  */\n  """;\n/* real */';
    const k = kinds(src);
    assert.equal(k.length, 2);
    assert.equal(k[0][0], 'string');
    assert.ok(k[0][1].endsWith('"""'));
    assert.deepEqual(k[1], ['blockComment', '/* real */']);
  });

  it('handles raw strings with more than three quotes', () => {
    const src = 'var s = """" a """ b """";/*c*/';
    assert.deepEqual(kinds(src), [
      ['string', '"""" a """ b """"'],
      ['blockComment', '/*c*/'],
    ]);
  });

  it('handles interpolated strings with nested strings in holes', () => {
    const src = 'var s = $"x {Format("/*a*/")} y {{z}}"; /*b*/';
    assert.deepEqual(kinds(src), [
      ['string', '$"x {Format("/*a*/")} y {{z}}"'],
      ['blockComment', '/*b*/'],
    ]);
  });

  it('handles interpolated verbatim and raw interpolated strings', () => {
    const src = 'var a = $@"{x}\n/*no*/"; var b = @$"{y}"; var c = $$"""{{v}} {not} /*no*/""";/*yes*/';
    const k = kinds(src);
    assert.deepEqual(
      k.map((t) => t[0]),
      ['string', 'string', 'string', 'blockComment'],
    );
    assert.equal(k[3][1], '/*yes*/');
  });

  it('handles format specifiers inside holes', () => {
    const src = 'var s = $"{value:N2} /*x*/"; /*y*/';
    assert.deepEqual(kinds(src), [
      ['string', '$"{value:N2} /*x*/"'],
      ['blockComment', '/*y*/'],
    ]);
  });

  it('handles char literals including quote and escape characters', () => {
    const src = "var a = '\"'; var b = '\\''; var c = '/'; /*d*/";
    assert.deepEqual(kinds(src), [
      ['char', "'\"'"],
      ['char', "'\\''"],
      ['char', "'/'"],
      ['blockComment', '/*d*/'],
    ]);
  });

  it('treats # at line start as a directive line, not a comment', () => {
    const src = '#!/usr/bin/env dotnet\n#:package A@1.0 /* no\n  #region R\nx; /* yes */';
    assert.deepEqual(kinds(src), [
      ['directive', '#!/usr/bin/env dotnet'],
      ['directive', '#:package A@1.0 /* no'],
      ['directive', '#region R'],
      ['blockComment', '/* yes */'],
    ]);
  });

  it('keeps regular strings single-line when unterminated', () => {
    const tokens = lexCSharp('var s = "abc\n/* c */');
    assert.equal(tokens[0].kind, 'string');
    assert.equal(tokens[0].terminated, false);
    assert.equal(tokens[1].kind, 'blockComment');
  });

  it('handles CRLF line endings', () => {
    const src = '// a\r\n/*b\r\n*/\r\nx;';
    assert.deepEqual(kinds(src), [
      ['lineComment', '// a'],
      ['blockComment', '/*b\r\n*/'],
    ]);
  });

  it('masks non-code while preserving offsets and newlines', () => {
    const src = 'a /* b\nc */ "d" e';
    const masked = maskNonCode(src);
    assert.equal(masked.length, src.length);
    assert.equal(masked, 'a     \n' + ' '.repeat(9) + 'e');
  });
});
