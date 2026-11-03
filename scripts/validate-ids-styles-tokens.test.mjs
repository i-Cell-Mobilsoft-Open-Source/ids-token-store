import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';

import {
  collectCustomPropertyDefinitions,
  collectCustomPropertyReferences,
  compareTokenSets,
  filterComponentTokens,
} from './validate-ids-styles-tokens.mjs';

function withCssFixture(files, callback) {
  const fixtureDirectory = mkdtempSync(path.join(tmpdir(), 'token-css-fixture-'));
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(fixtureDirectory, relativePath);
      mkdirSync(path.dirname(filePath), { recursive: true });
      writeFileSync(filePath, content, 'utf8');
    }
    callback(fixtureDirectory);
  } finally {
    rmSync(fixtureDirectory, { recursive: true, force: true });
  }
}

test('collects unique custom property definitions from nested generated CSS', () => {
  withCssFixture(
    {
      'base/base.css': `
        :root {
          --ids-alpha: red;
          --ids-beta: var(--ids-foundation, blue);
        }
        /* --ids-commented-out: black; */
      `,
      'component/component.css': `
        .ids-theme { --ids-alpha: green; --ids-gamma_2: 2px }
      `,
      'tokens.css': '@import "./base/base.css";',
    },
    (fixtureDirectory) => {
      assert.deepEqual(
        [...collectCustomPropertyDefinitions(fixtureDirectory)].sort(),
        ['--ids-alpha', '--ids-beta', '--ids-gamma_2'],
      );
    },
  );
});

test('collects every var reference, including multiple calls and fallbacks', () => {
  withCssFixture(
    {
      'dist/component.css': `
        .example {
          color: var(--ids-alpha, var(--ids-fallback));
          box-shadow: var(--ids-beta) 0 0 var( --ids-gamma, 2px);
        }
        /* color: var(--ids-commented-out); */
      `,
      'dist/component.min.css':
        '.example{color:var(--ids-alpha);border-color:var(--ids-beta)}',
    },
    (fixtureDirectory) => {
      assert.deepEqual(
        [...collectCustomPropertyReferences(fixtureDirectory)].sort(),
        ['--ids-alpha', '--ids-beta', '--ids-fallback', '--ids-gamma'],
      );
    },
  );
});

test('filters comparison input to component tokens', () => {
  const componentTokens = filterComponentTokens(
    new Set([
      '--ids-base-color-blue-500',
      '--ids-comp-button-size-height-compact',
      '--ids-comp-card-color-bg-default',
      '--ids-smc-reference-container-size-height-32',
    ]),
  );

  assert.deepEqual(
    [...componentTokens].sort(),
    ['--ids-comp-button-size-height-compact', '--ids-comp-card-color-bg-default'],
  );
});

test('compares Sets and returns alphabetically sorted differences', () => {
  const differences = compareTokenSets(
    new Set(['--ids-zulu', '--ids-shared', '--ids-alpha']),
    new Set(['--ids-missing-zulu', '--ids-shared', '--ids-missing-alpha']),
  );

  assert.deepEqual(differences, {
    missingFromGenerated: ['--ids-missing-alpha', '--ids-missing-zulu'],
    notDirectlyReferencedByStyles: ['--ids-alpha', '--ids-zulu'],
  });
});

// Run the unchanged validator end to end against a local ids-styles fixture.
// Git rewrites its fixed upstream URL to a temporary repository; no network
// or live target publication is involved. The fixture build has no dependencies.
for (const missing of [false, true]) {
  test(`validator CLI builds the selected ref, writes a report and ${missing ? 'fails for missing tokens' : 'succeeds for matching tokens'}`, (t) => {
    const root = mkdtempSync(path.join(tmpdir(), 'validation-integration-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const styles = path.join(root, 'styles');
    const source = path.join(root, 'source');
    mkdirSync(styles); mkdirSync(source); mkdirSync(path.join(source, 'ids_css'));
    writeFileSync(path.join(source, 'ids_css', 'tokens.css'), ':root { --ids-comp-present: 1px; }');
    writeFileSync(path.join(styles, 'package.json'), JSON.stringify({ name: 'styles-fixture', version: '1.0.0',
      scripts: { build: 'node build.cjs' } }));
    writeFileSync(path.join(styles, 'package-lock.json'), JSON.stringify({ name: 'styles-fixture', version: '1.0.0',
      lockfileVersion: 3, packages: { '': { name: 'styles-fixture', version: '1.0.0' } } }));
    const token = missing ? '--ids-comp-missing' : '--ids-comp-present';
    writeFileSync(path.join(styles, 'build.cjs'), `const fs = require('node:fs'); fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/styles.css', '.test { color: var(${token}); }');`);
    const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
      GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid',
      npm_config_cache: path.join(root, 'npm-cache') };
    for (const args of [['init', '--initial-branch=main'], ['add', '.'], ['commit', '-m', 'Fixture'], ['tag', 'fixture-ref']]) {
      const result = spawnSync('git', args, { cwd: styles, env, encoding: 'utf8' });
      assert.equal(result.status, 0, result.stderr);
    }
    const result = spawnSync(process.execPath, [fileURLToPath(new URL('./validate-ids-styles-tokens.mjs', import.meta.url))], {
      cwd: source, encoding: 'utf8', env: { ...env, IDS_STYLES_REF: 'fixture-ref',
        CSS_OUTPUT_DIR: 'ids_css', TOKEN_DIFF_REPORT_PATH: 'token-diff-report.json',
        GIT_CONFIG_COUNT: '1', GIT_ALLOW_PROTOCOL: 'file',
        GIT_CONFIG_KEY_0: `url.file://${styles}.insteadOf`,
        GIT_CONFIG_VALUE_0: 'https://github.com/i-Cell-Mobilsoft-Open-Source/ids-styles.git' },
    });
    assert.equal(result.status, missing ? 1 : 0, result.stdout + result.stderr);
    const report = JSON.parse(readFileSync(path.join(source, 'token-diff-report.json'), 'utf8'));
    assert.equal(report.idsStylesRef, 'fixture-ref');
    assert.equal(report.generatedTokenCount, 1);
    assert.equal(report.referencedTokenCount, 1);
    assert.deepEqual(report.missingFromGenerated, missing ? ['--ids-comp-missing'] : []);
  });
}
