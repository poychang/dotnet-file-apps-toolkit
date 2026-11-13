import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import {
  buildConvertArgs,
  buildFileAppCacheCleanArgs,
  buildFormatArgs,
  buildPackArgs,
  buildPublishArgs,
  buildReferenceArgs,
  buildRunArgs,
  convertedProjectFile,
  defaultConvertOutputDir,
  defaultPublishOutputDir,
  formatArgumentString,
  isPublishAotDisabled,
  isPackAsToolDisabled,
  parseArgumentString,
} from '../../src/dotnet/cliArgs';
import { analyzeFileAppText } from '../../src/dotnet/fileAppSignals';

function parsed(input: string): string[] {
  const r = parseArgumentString(input);
  assert.ok(r.ok, `expected "${input}" to parse`);
  return r.args;
}

describe('cliArgs', () => {
  it('always runs the file with --file and separates application arguments', () => {
    assert.deepEqual(buildRunArgs('/w/app.cs'), ['run', '--file', '/w/app.cs']);
    assert.deepEqual(buildRunArgs('/w/app.cs', ['--verbose', 'a b']), ['run', '--file', '/w/app.cs', '--', '--verbose', 'a b']);
    assert.deepEqual(buildRunArgs('/w/app.cs', ['--verbose'], 'Development'), [
      'run',
      '--file',
      '/w/app.cs',
      '--launch-profile',
      'Development',
      '--',
      '--verbose',
    ]);
  });

  it('passes optional output folders as discrete arguments', () => {
    assert.deepEqual(buildPackArgs('/w/app.cs'), ['pack', '/w/app.cs']);
    assert.deepEqual(buildPublishArgs('/w/app.cs'), ['publish', '/w/app.cs']);
    assert.deepEqual(buildPublishArgs('/w/app.cs', '/o u t'), ['publish', '/w/app.cs', '--output', '/o u t']);
    assert.deepEqual(buildConvertArgs('/w/app.cs', '/w/p'), ['project', 'convert', '/w/app.cs', '--output', '/w/p']);
  });

  it('cleans the file-based app cache with a validated retention period', () => {
    assert.deepEqual(buildFileAppCacheCleanArgs(30), ['clean', 'file-based-apps', '--days', '30']);
    assert.deepEqual(buildFileAppCacheCleanArgs(0), ['clean', 'file-based-apps', '--days', '0']);
    for (const days of [-1, 1.5, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => buildFileAppCacheCleanArgs(days), RangeError);
    }
  });

  it('builds project reference and file-app format arguments without shell quoting', () => {
    assert.deepEqual(buildReferenceArgs('add', '/w/app.cs', ['/w/lib project/lib.csproj']), [
      'reference',
      'add',
      '/w/lib project/lib.csproj',
      '--file',
      '/w/app.cs',
    ]);
    assert.deepEqual(buildReferenceArgs('list', '/w/app.cs'), ['reference', 'list', '--file', '/w/app.cs']);
    assert.deepEqual(buildReferenceArgs('remove', '/w/app.cs', ['/w/lib.csproj']), [
      'reference',
      'remove',
      '/w/lib.csproj',
      '--file',
      '/w/app.cs',
    ]);
    assert.deepEqual(buildFormatArgs('/w/app file.cs'), ['format', '/w/app file.cs']);
    assert.throws(() => buildReferenceArgs('add', '/w/app.cs'), RangeError);
  });

  it('computes the documented default convert and publish folders', () => {
    const file = path.join('w', 'tools', 'my.app.cs');
    assert.equal(defaultConvertOutputDir(file), path.join('w', 'tools', 'my.app'));
    assert.equal(defaultPublishOutputDir(file), path.join('w', 'tools', 'artifacts', 'my.app'));
    assert.equal(convertedProjectFile(file, path.join('x')), path.join('x', 'my.app.csproj'));
  });

  it('detects #:property PublishAot=false', () => {
    assert.equal(isPublishAotDisabled(analyzeFileAppText('#:property PublishAot=false\nConsole.WriteLine();').directives), true);
    assert.equal(isPublishAotDisabled(analyzeFileAppText('#:property publishaot = False\n').directives), true);
    assert.equal(isPublishAotDisabled(analyzeFileAppText('#:property PublishAot=true\n').directives), false);
    assert.equal(isPublishAotDisabled(analyzeFileAppText('// #:property PublishAot=false\nx();').directives), false);
  });

  it('detects #:property PackAsTool=false', () => {
    assert.equal(isPackAsToolDisabled(analyzeFileAppText('#:property PackAsTool=false\nConsole.WriteLine();').directives), true);
    assert.equal(isPackAsToolDisabled(analyzeFileAppText('#:property packastool = False\n').directives), true);
    assert.equal(isPackAsToolDisabled(analyzeFileAppText('#:property PackAsTool=true\n').directives), false);
    assert.equal(isPackAsToolDisabled(analyzeFileAppText('// #:property PackAsTool=false\nx();').directives), false);
  });

  describe('parseArgumentString', () => {
    it('splits on whitespace and keeps Windows paths intact', () => {
      assert.deepEqual(parsed('  a  b\tc '), ['a', 'b', 'c']);
      assert.deepEqual(parsed('C:\\temp\\x.txt \\\\server\\share'), ['C:\\temp\\x.txt', '\\\\server\\share']);
      assert.deepEqual(parsed(''), []);
    });

    it('supports double quotes with \\" escapes, single quotes and concatenation', () => {
      assert.deepEqual(parsed('"hello world" \'it is\' --name="A B"'), ['hello world', 'it is', '--name=A B']);
      assert.deepEqual(parsed('"say \\"hi\\"" \\"bare\\"'), ['say "hi"', '"bare"']);
      assert.deepEqual(parsed('"" \'\''), ['', '']);
      assert.deepEqual(parsed('\'$HOME ${x} %PATH%\''), ['$HOME ${x} %PATH%']);
    });

    it('reports unterminated quotes with their position', () => {
      assert.deepEqual(parseArgumentString('a "b c'), { ok: false, error: 'unterminated-double-quote', position: 2 });
      assert.deepEqual(parseArgumentString("x 'y"), { ok: false, error: 'unterminated-single-quote', position: 2 });
    });

    it('round-trips formatted arguments', () => {
      const samples = [
        ['plain', 'with space', ''],
        ['C:\\Program Files\\', 'quote"inside', "it's"],
        ["it's \"both\" \\", 'tab\there', '--flag=a b'],
      ];
      for (const args of samples) {
        assert.deepEqual(parsed(formatArgumentString(args)), args);
      }
    });
  });
});
