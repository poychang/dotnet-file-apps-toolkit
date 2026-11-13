import * as assert from 'node:assert/strict';
import { parseLaunchProfiles } from '../../src/dotnet/launchProfiles';

describe('parseLaunchProfiles', () => {
  it('parses supported profiles from JSON with comments and trailing commas', () => {
    const result = parseLaunchProfiles(`{
      // The standard launch settings format
      "profiles": {
        "Development": { "commandName": "Project", },
        "External": { "commandName": "Executable" },
        "Unsupported": { "commandName": "Docker" },
      },
    }`);
    assert.deepEqual(result, {
      ok: true,
      profiles: [
        { name: 'Development', commandName: 'Project' },
        { name: 'External', commandName: 'Executable' },
      ],
    });
  });

  it('returns no profiles when launch settings do not declare them', () => {
    assert.deepEqual(parseLaunchProfiles('{}'), { ok: true, profiles: [] });
  });

  it('rejects invalid JSON and malformed profiles', () => {
    assert.equal(parseLaunchProfiles('{').ok, false);
    assert.equal(parseLaunchProfiles('[]').ok, false);
    assert.equal(parseLaunchProfiles('{"profiles":[]}').ok, false);
  });

  it('rejects profile names that collide case-insensitively', () => {
    const result = parseLaunchProfiles('{"profiles":{"Development":{"commandName":"Project"},"development":{"commandName":"Project"}}}');
    assert.deepEqual(result, {
      ok: false,
      error: 'Profile names that differ only by case are ambiguous: development',
    });
    assert.equal(
      parseLaunchProfiles('{"profiles":{"Dev":{"commandName":"Docker"},"dev":{"commandName":"Project"}}}').ok,
      false,
    );
  });
});
