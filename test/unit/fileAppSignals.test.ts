import * as assert from 'node:assert/strict';
import { analyzeFileAppText, decideFileApp, hasTopLevelStatements, needsProjectConeCheck } from '../../src/dotnet/fileAppSignals';
import { maskNonCode } from '../../src/csharp/csharpLexer';

function topLevel(src: string): boolean {
  return hasTopLevelStatements(maskNonCode(src));
}

describe('fileAppSignals', () => {
  describe('analyzeFileAppText', () => {
    it('detects leading #: directives after comments', () => {
      const a = analyzeFileAppText('// header\n/* note */\n#:package Humanizer@2.14.1\n#:property PublishAot=false\nConsole.WriteLine();');
      assert.deepEqual(
        a.directives.map((d) => [d.name, d.value]),
        [
          ['package', 'Humanizer@2.14.1'],
          ['property', 'PublishAot=false'],
        ],
      );
      assert.equal(a.hasTopLevelStatements, true);
    });

    it('ignores #: lines after code and inside strings or comments', () => {
      const a = analyzeFileAppText('Console.WriteLine();\n#:package Late@1.0\n');
      assert.equal(a.directives.length, 0);
      const b = analyzeFileAppText('/*\n#:package X@1\n*/\nvar s = "#:sdk Y";');
      assert.equal(b.directives.length, 0);
    });

    it('detects a dotnet shebang only on the first line', () => {
      assert.equal(analyzeFileAppText('#!/usr/bin/env -S dotnet --\nConsole.WriteLine();').hasDotnetShebang, true);
      assert.equal(analyzeFileAppText('\uFEFF#!/usr/bin/env dotnet\n').hasDotnetShebang, true);
      assert.equal(analyzeFileAppText('#!/usr/bin/env python\n').hasDotnetShebang, false);
    });
  });

  describe('hasTopLevelStatements', () => {
    it('finds executable statements', () => {
      assert.equal(topLevel('using System;\nConsole.WriteLine("hi");'), true);
      assert.equal(topLevel('using var f = File.OpenRead("x");'), true);
      assert.equal(topLevel('if (args.Length > 0) { return; }'), true);
      assert.equal(topLevel('var o = new { A = 1 };'), true);
      assert.equal(topLevel('static int Add(int a, int b) { return a + b; }'), true);
    });

    it('ignores declarations-only files', () => {
      assert.equal(topLevel('using System;\nnamespace App;\npublic class C { void M() { Console.WriteLine(); } }'), false);
      assert.equal(topLevel('namespace App { class C { } }'), false);
      assert.equal(topLevel('[assembly: InternalsVisibleTo("x")]\ninternal sealed partial class C { }\nrecord R(int X);\nenum E { A, B }'), false);
      assert.equal(topLevel('global using static System.Math;\nusing Alias = System.Collections.Generic.List<int>;'), false);
      assert.equal(topLevel('// Console.WriteLine();\n/* var x = 1; */'), false);
    });

    it('stops at a file-scoped namespace', () => {
      assert.equal(topLevel('namespace App;\nclass C {}\n'), false);
    });
  });

  describe('decideFileApp', () => {
    const strong = analyzeFileAppText('#:package A@1\nConsole.WriteLine();');
    const candidate = analyzeFileAppText('Console.WriteLine();');
    const library = analyzeFileAppText('namespace N; class C {}');

    it('accepts strong signals in strict mode and rejects candidates', () => {
      assert.deepEqual(decideFileApp('strict', undefined, strong, false), { isFileApp: true, reason: 'directives', signal: 'strong' });
      assert.equal(decideFileApp('strict', undefined, candidate, false).isFileApp, false);
      assert.equal(decideFileApp('strict', undefined, candidate, false).signal, 'candidate');
    });

    it('accepts candidates outside projects in standalone mode', () => {
      assert.equal(decideFileApp('standalone', undefined, candidate, false).isFileApp, true);
      assert.deepEqual(decideFileApp('standalone', undefined, candidate, true), {
        isFileApp: false,
        reason: 'inside-project',
        signal: 'none',
      });
      assert.equal(decideFileApp('standalone', undefined, library, false).isFileApp, false);
    });

    it('honors manual mode and overrides', () => {
      assert.equal(decideFileApp('manual', undefined, strong, false).isFileApp, false);
      assert.equal(decideFileApp('manual', 'enabled', library, false).isFileApp, true);
      assert.equal(decideFileApp('strict', 'disabled', strong, false).reason, 'override-disabled');
    });

    it('only requests the project-cone lookup when it can change the outcome', () => {
      assert.equal(needsProjectConeCheck('standalone', candidate), true);
      assert.equal(needsProjectConeCheck('strict', candidate), false);
      assert.equal(needsProjectConeCheck('standalone', strong), false);
      assert.equal(needsProjectConeCheck('standalone', library), false);
    });
  });
});
