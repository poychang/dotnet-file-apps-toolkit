import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { test } from 'node:test';
import { URL } from 'node:url';
import { prepareRelease } from '../../scripts/prepare-release.mjs';

const manifest = { version: '1.2.3', engines: { vscode: '^1.100.0' } };
const lock = { version: '1.2.3', packages: { '': { version: '1.2.3' } } };
const changelog = '# Changelog\n\n## Unreleased\n\n## 1.2.3\n\n- New release feature.\n\n## 1.2.2\n\n- Older feature.\n';

test('release notes include only the tagged version and installation instructions', () => {
  const notes = prepareRelease('v1.2.3', manifest, lock, changelog.replaceAll('\n', '\r\n'));
  assert.match(notes, /New release feature/);
  assert.doesNotMatch(notes, /Older feature|Unreleased/);
  assert.match(notes, /code --install-extension \.\/dotnet-file-apps-toolkit\.vsix/);
});

test('rejects invalid tags, version drift, missing notes and unpublished changes', () => {
  for (const tag of ['main', 'v01.2.3', 'v1.2.3-beta.1', undefined]) {
    assert.throws(() => prepareRelease(tag, manifest, lock, changelog), /stable version/);
  }
  assert.throws(() => prepareRelease('v1.2.4', manifest, lock, changelog), /does not match/);
  assert.throws(() => prepareRelease('v1.2.3', manifest, { ...lock, version: '1.2.2' }, changelog), /package-lock/);
  assert.throws(() => prepareRelease('v1.2.3', manifest, { ...lock, packages: {} }, changelog), /package-lock/);
  assert.throws(() => prepareRelease('v1.2.3', manifest, lock, '## 1.2.2\n- Previous version'), /nonempty/);
  assert.throws(() => prepareRelease('v1.2.3', manifest, lock, '## 1.2.3\n\n## 1.2.2\n- Previous version'), /nonempty/);
  assert.throws(() => prepareRelease('v1.2.3', manifest, lock, '## 1.2.3'), /nonempty/);
  assert.throws(() => prepareRelease('v1.2.3', manifest, lock, changelog.replace('## Unreleased', '## Unreleased\n- Pending change.')), /Move Unreleased/);
});

test('the Pages artifact includes all local links and images under its project subpath', () => {
  const site = new URL('../../out/site/', import.meta.url);
  const html = readFileSync(new URL('index.html', site), 'utf8');
  const ids = new Set([...html.matchAll(/\bid="([^"]+)"/g)].map((match) => match[1]));
  for (const [, target] of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
    if (/^https:\/\//.test(target)) {
      continue;
    }
    if (target.startsWith('#')) {
      assert.ok(ids.has(target.slice(1)), `Missing section: ${target}`);
      continue;
    }
    assert.ok(target.startsWith('./'), `Local URL must be project-relative: ${target}`);
    assert.ok(existsSync(new URL(target, site)), `Missing site asset: ${target}`);
  }
  assert.match(html, /https:\/\/github\.com\/poychang\/dotnet-file-apps-toolkit\/releases\/latest\/download\/dotnet-file-apps-toolkit\.vsix/);
});
