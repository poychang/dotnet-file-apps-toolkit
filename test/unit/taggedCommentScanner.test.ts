import * as assert from 'node:assert/strict';
import { defaultRegistry, EmbeddedLanguageRegistry } from '../../src/comments/embeddedLanguageRegistry';
import { LineIndex, normalizeBody } from '../../src/comments/normalization';
import { findBlockAt, scanTaggedComments } from '../../src/comments/taggedCommentScanner';

function languages(text: string): string[] {
  return scanTaggedComments(text).blocks.map((b) => b.language);
}

describe('EmbeddedLanguageRegistry', () => {
  it('resolves canonical IDs and aliases case-insensitively', () => {
    const cases: Array<[string, string]> = [
      ['markdown', 'markdown'],
      ['MD', 'markdown'],
      ['Yml', 'yaml'],
      ['json', 'json'],
      ['SQL', 'sql'],
      ['xml', 'xml'],
      ['sh', 'bash'],
      ['shell', 'bash'],
      ['ps1', 'powershell'],
      ['cs', 'csharp'],
      ['JS', 'javascript'],
      ['mjs', 'javascript'],
      ['TS', 'typescript'],
      ['htm', 'html'],
      ['py', 'python'],
      ['C++', 'cpp'],
      ['cxx', 'cpp'],
      ['cfg', 'ini'],
      ['docker', 'dockerfile'],
    ];
    for (const [tag, id] of cases) {
      assert.equal(defaultRegistry.resolve(tag)?.id, id, tag);
    }
    for (const tag of ['markdownExtra', 'todo', '']) {
      assert.equal(defaultRegistry.resolve(tag), undefined, tag);
    }
  });

  it('rejects duplicate tags', () => {
    assert.throws(
      () =>
        new EmbeddedLanguageRegistry([
          { id: 'a', displayName: 'A', aliases: ['x'], mode: 'code' },
          { id: 'b', displayName: 'B', aliases: ['X'], mode: 'code' },
        ]),
      /Duplicate/,
    );
  });
});

describe('normalizeBody', () => {
  it('removes common indentation and maps every display column back to the source', () => {
    const text = '    /*yaml\r\n    server:\r\n      port: 8080\r\n\r\n    */';
    const start = text.indexOf('server');
    const lines = new LineIndex(text);
    const end = text.lastIndexOf('    */');
    const body = normalizeBody(text, start - 4, end, lines);
    assert.equal(body.indent, '    ');
    assert.equal(body.text, 'server:\n  port: 8080\n');
    assert.deepEqual(
      body.lines.map((l) => [l.sourceLine, text.slice(l.sourceOffset, l.sourceOffset + l.text.length) === l.text]),
      [
        [1, true],
        [2, true],
        [3, true],
      ],
    );
  });

  it('keeps tabs and mixed indentation intact when there is no common prefix', () => {
    const text = '\tkey: 1\n  other: 2\n';
    const body = normalizeBody(text, 0, text.length, new LineIndex(text));
    assert.equal(body.indent, '');
    assert.equal(body.text, '\tkey: 1\n  other: 2');
  });
});

describe('scanTaggedComments', () => {
  it('recognizes the documented sample with source maps', () => {
    const text = [
      '/*markdown',
      '# Quick start',
      '',
      '**Important**: use the `--file` flag.',
      '*/',
      '',
      '/*yaml',
      'server:',
      '  port: 8080',
      '*/',
      '',
      '/*sql',
      'SELECT name FROM users;',
      '*/',
      '',
      '// Ordinary text and XML docs stay untouched:',
      '/** C# documentation comment */',
      '/* This is just a normal comment. */',
      '',
      'var sample = "/*json\\n{ \\"not\\": \\"a real comment\\" }\\n*/";',
    ].join('\n');
    const scan = scanTaggedComments(text);
    assert.deepEqual(
      scan.blocks.map((b) => [b.language, b.mode, b.startLine, b.endLine]),
      [
        ['markdown', 'document', 0, 4],
        ['yaml', 'code', 6, 9],
        ['sql', 'code', 11, 13],
      ],
    );
    const md = scan.blocks[0];
    assert.equal(md.rawBody, '# Quick start\n\n**Important**: use the `--file` flag.\n');
    assert.equal(text.slice(md.bodyStartOffset, md.bodyEndOffset), md.rawBody);
    assert.equal(text.slice(md.startOffset, md.endOffset).endsWith('*/'), true);
    assert.equal(scan.blocks[1].normalizedBody, 'server:\n  port: 8080');
    assert.deepEqual(scan.unknownTags, []);
  });

  it('accepts aliases, casing and trailing whitespace after the tag', () => {
    assert.deepEqual(languages('/*MD  \n# t\n*/\n/*yml\t\r\na: 1\r\n*/\n/*Json\r{}\r*/'), ['markdown', 'yaml', 'json']);
  });

  it('requires the tag to be alone on the opening line', () => {
    for (const src of ['/*yaml a: 1\n*/', '/*yaml */', '/*yaml*/', '/*markdown# t\n*/', '/*', '/*yaml']) {
      assert.deepEqual(languages(src), [], JSON.stringify(src));
    }
  });

  it('leaves ordinary, documentation and unknown-tag comments alone', () => {
    const text = '/** doc */\n/* normal */\n/*\nmarkdown\n*/\n/* markdown\nx\n*/\n/*markdownExtra\nx\n*/\n/*TODO\nlater\n*/\n// /*yaml\n';
    const scan = scanTaggedComments(text);
    assert.deepEqual(scan.blocks, []);
    assert.deepEqual(
      scan.unknownTags.map((u) => [u.tag, u.startLine, text.slice(u.tagStartOffset, u.tagEndOffset)]),
      [
        ['markdownExtra', 8, 'markdownExtra'],
        ['TODO', 11, 'TODO'],
      ],
    );
  });

  it('ignores tag-like text inside every kind of string, char and line comment', () => {
    const text = [
      'var a = "/*yaml\\nk: v\\n*/";',
      'var b = @"/*yaml',
      'k: v',
      '*/";',
      'var c = """',
      '  /*json',
      '  {}',
      '  */',
      '  """;',
      'var d = $"{x /*sql\n*/}/*yaml\\n*/";',
      "var e = '/';",
      '// /*markdown',
      '/*yaml',
      'real: true',
      '*/',
    ].join('\n');
    const scan = scanTaggedComments(text);
    assert.deepEqual(scan.blocks.map((b) => [b.language, b.normalizedBody]), [['yaml', 'real: true']]);
  });

  it('closes at the first */ even when the body would treat it as content', () => {
    const text = '/*json\n{ "pattern": "a*/b" }\n*/';
    const [block] = scanTaggedComments(text).blocks;
    assert.equal(block.rawBody, '{ "pattern": "a');
    assert.equal(block.endOffset, text.indexOf('*/') + 2);
  });

  it('handles empty, unterminated, CRLF and Unicode bodies', () => {
    const [empty] = scanTaggedComments('/*yaml\n*/').blocks;
    assert.equal(empty.rawBody, '');
    assert.deepEqual(empty.lineMap, []);

    const open = '/*markdown\r\n# 標題 🚀\r\n內容';
    const [unterminated] = scanTaggedComments(open).blocks;
    assert.equal(unterminated.terminated, false);
    assert.equal(unterminated.endOffset, open.length);
    assert.equal(unterminated.rawBody, '# 標題 🚀\r\n內容');
    assert.equal(unterminated.normalizedBody, '# 標題 🚀\n內容');
    assert.deepEqual(unterminated.lineMap.map((l) => l.sourceLine), [1, 2]);

    const inline = '/*sql\nSELECT 1; */';
    assert.equal(scanTaggedComments(inline).blocks[0].rawBody, 'SELECT 1; ');
  });

  it('keeps YAML indentation relative and preserves the exact raw body for copy', () => {
    const text = 'class C {\n    /*yaml\n    root:\n      child: 1\n    */\n}';
    const [block] = scanTaggedComments(text).blocks;
    assert.equal(block.rawBody, '    root:\n      child: 1\n');
    assert.equal(block.normalizedBody, 'root:\n  child: 1');
    assert.equal(block.lineMap[1].text, '  child: 1');
    assert.equal(text.slice(block.lineMap[1].sourceOffset).startsWith('  child: 1'), true);
  });

  it('caps the number of blocks and finds a block by offset', () => {
    const text = Array.from({ length: 5 }, (_, i) => `/*yaml\nn: ${i}\n*/`).join('\n\n');
    const capped = scanTaggedComments(text, { maxBlocks: 3 });
    assert.equal(capped.blocks.length, 3);
    assert.equal(capped.truncated, true);

    const scan = scanTaggedComments(text);
    const third = scan.blocks[2];
    assert.equal(findBlockAt(scan, third.startOffset)?.index, 2);
    assert.equal(findBlockAt(scan, third.bodyStartOffset + 1)?.index, 2);
    assert.equal(findBlockAt(scan, third.endOffset + 1), undefined);
  });
});
