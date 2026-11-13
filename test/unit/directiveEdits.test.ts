import * as assert from 'node:assert/strict';
import { makeDirectiveInsertion, packageDirectiveId, parsePackageReference } from '../../src/dotnet/directiveEdits';
import { analyzeFileAppText } from '../../src/dotnet/fileAppSignals';

describe('directiveEdits', () => {
  describe('parsePackageReference', () => {
    it('accepts package IDs with exact versions and version ranges', () => {
      assert.deepEqual(parsePackageReference('Humanizer@2.14.1'), {
        id: 'Humanizer',
        version: '2.14.1',
        value: 'Humanizer@2.14.1',
      });
      assert.deepEqual(parsePackageReference('Humanizer@[2.0, 3.0)'), {
        id: 'Humanizer',
        version: '[2.0, 3.0)',
        value: 'Humanizer@[2.0, 3.0)',
      });
      assert.equal(packageDirectiveId('Humanizer@2.14.1'), 'Humanizer');
      assert.equal(packageDirectiveId('Humanizer'), 'Humanizer');
    });

    it('rejects malformed or multi-line references', () => {
      for (const value of ['@1.0', 'Humanizer@', 'Humanizer@1\n#:property X=Y', 'Bad ID@1.0', 'Humanizer@1@2']) {
        assert.equal(parsePackageReference(value), undefined, value);
      }
    });
  });

  describe('makeDirectiveInsertion', () => {
    it('keeps a BOM and shebang first and inserts with the source newline style', () => {
      const source = '\uFEFF#!/usr/bin/env dotnet\r\n// header\r\nConsole.WriteLine();\r\n';
      const analysis = analyzeFileAppText(source);
      const edit = makeDirectiveInsertion(source, analysis, '#:package Humanizer@2.14.1');
      assert.equal(
        source.slice(0, edit.start) + edit.text + source.slice(edit.end),
        '\uFEFF#!/usr/bin/env dotnet\r\n#:package Humanizer@2.14.1\r\n// header\r\nConsole.WriteLine();\r\n',
      );
    });

    it('places a new directive after existing directives and handles a missing final newline', () => {
      const source = '// header\n#:property PublishAot=false';
      const analysis = analyzeFileAppText(source);
      const edit = makeDirectiveInsertion(source, analysis, '#:package Humanizer@2.14.1');
      assert.equal(
        source.slice(0, edit.start) + edit.text + source.slice(edit.end),
        '// header\n#:property PublishAot=false\n#:package Humanizer@2.14.1\n',
      );
    });

    it('inserts a directive at the start of an empty or BOM-only file', () => {
      assert.deepEqual(makeDirectiveInsertion('', analyzeFileAppText(''), '#:package A@1'), {
        start: 0,
        end: 0,
        text: '#:package A@1\n',
      });
      assert.deepEqual(makeDirectiveInsertion('\uFEFF', analyzeFileAppText('\uFEFF'), '#:package A@1'), {
        start: 1,
        end: 1,
        text: '#:package A@1\n',
      });
    });
  });
});
