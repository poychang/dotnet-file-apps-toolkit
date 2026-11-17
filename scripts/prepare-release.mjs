import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

export function prepareRelease(tag, manifest, lock, changelog) {
  if (!/^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(tag ?? '')) {
    throw new Error('Release tag must be a stable version such as v0.2.1 (no prerelease suffix).');
  }
  const version = tag.slice(1);
  if (manifest.version !== version) {
    throw new Error(`Tag ${tag} does not match package.json version ${manifest.version}.`);
  }
  if (lock.version !== version || lock.packages?.['']?.version !== version) {
    throw new Error('package-lock.json versions must match package.json. Run npm version with --no-git-tag-version.');
  }
  const sections = changelog.replaceAll('\r\n', '\n').split(/^## /m).slice(1).map((entry) => {
    const [heading, ...lines] = entry.split('\n');
    return { heading: heading.trim(), body: lines.join('\n').trim() };
  });
  const section = sections.find((entry) => entry.heading === version);
  if (!section?.body) {
    throw new Error(`CHANGELOG.md must contain a nonempty "## ${version}" section.`);
  }
  const unreleased = sections.find((entry) => entry.heading === 'Unreleased');
  if (unreleased?.body) {
    throw new Error('Move Unreleased entries into the release version section before tagging.');
  }
  return `## ${version}\n\n${section.body}\n\n### Manual installation\n\nDownload \`dotnet-file-apps-toolkit.vsix\` and run **Extensions: Install from VSIX...** in VS Code, or:\n\n\`\`\`sh\ncode --install-extension ./dotnet-file-apps-toolkit.vsix\n\`\`\`\n\nRequires VS Code ${manifest.engines.vscode} and .NET SDK 10.0.100+ for CLI commands.\nVerify the download against \`SHA256SUMS\` attached to this release.\n`;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = new URL('../', import.meta.url);
  const manifest = JSON.parse(readFileSync(new URL('package.json', root), 'utf8'));
  const lock = JSON.parse(readFileSync(new URL('package-lock.json', root), 'utf8'));
  const changelog = readFileSync(new URL('CHANGELOG.md', root), 'utf8');
  const notes = prepareRelease(process.argv[2], manifest, lock, changelog);
  mkdirSync(new URL('out/', root), { recursive: true });
  writeFileSync(new URL('out/release-notes.md', root), notes);
  console.log(`Validated ${process.argv[2]}; wrote out/release-notes.md.`);
}
