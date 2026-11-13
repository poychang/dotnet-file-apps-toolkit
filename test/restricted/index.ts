import * as path from 'node:path';
import Mocha from 'mocha';

/** Entry point for `--extensionTestsPath` (see scripts/run-restricted-tests.mjs). */
export function run(): Promise<void> {
  const mocha = new Mocha({ ui: 'bdd', timeout: 300_000, color: true });
  mocha.addFile(path.join(__dirname, 'restrictedMode.test.js'));
  return new Promise((resolve, reject) => {
    mocha.run((failures) => (failures > 0 ? reject(new Error(`${failures} Restricted Mode test(s) failed.`)) : resolve()));
  });
}
