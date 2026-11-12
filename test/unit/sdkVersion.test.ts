import * as assert from 'node:assert/strict';
import { compareSdkVersions, extractSdkVersion, getSdkCapabilities, parseSdkVersion } from '../../src/dotnet/sdkVersion';

function v(s: string) {
  const parsed = parseSdkVersion(s);
  assert.ok(parsed, `expected ${s} to parse`);
  return parsed;
}

describe('sdkVersion', () => {
  it('parses release and prerelease versions', () => {
    assert.deepEqual(v('10.0.204').prerelease, []);
    assert.deepEqual(v('10.0.100-rc.1.25451.107').prerelease, ['rc', '1', '25451', '107']);
    assert.equal(parseSdkVersion('not a version'), undefined);
  });

  it('extracts the version from noisy dotnet --version output', () => {
    const out = 'Welcome to .NET 10.0!\n---------------------\nSDK Version: 10.0.204\n\n10.0.204\n';
    assert.equal(extractSdkVersion(out)?.raw, '10.0.204');
    assert.equal(extractSdkVersion('error only'), undefined);
  });

  it('orders versions with prerelease precedence', () => {
    const ordered = ['9.0.319', '10.0.100-preview.7.1', '10.0.100-rc.1.25451.107', '10.0.100', '10.0.204', '11.0.100'];
    for (let i = 1; i < ordered.length; i++) {
      assert.equal(compareSdkVersions(v(ordered[i - 1]), v(ordered[i])), -1, `${ordered[i - 1]} < ${ordered[i]}`);
    }
    assert.equal(compareSdkVersions(v('10.0.204'), v('10.0.204')), 0);
  });

  it('gates file-based app features by SDK band', () => {
    assert.equal(getSdkCapabilities(v('9.0.319')).fileBasedApps, false);
    const ten = getSdkCapabilities(v('10.0.204'));
    assert.equal(ten.fileBasedApps, true);
    assert.equal(ten.includeDirective, false);
    assert.equal(ten.referenceFileCommands, false);
    assert.equal(getSdkCapabilities(v('10.0.300')).includeDirective, true);
    assert.equal(getSdkCapabilities(v('10.0.300')).includeDllDirective, false);
    const eleven = getSdkCapabilities(v('11.0.100'));
    assert.equal(eleven.includeDllDirective, true);
    assert.equal(eleven.referenceFileCommands, true);
    assert.equal(getSdkCapabilities(v('10.0.100-rc.1.25451.107')).prerelease, true);
  });
});
