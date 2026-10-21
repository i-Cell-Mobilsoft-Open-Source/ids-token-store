import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { collectCustomPropertyDefinitions, compareTokenSets, filterComponentTokens } from './validate-ids-styles-tokens.mjs';

const repository = fileURLToPath(new URL('..', import.meta.url));
const legacyFiles = ['base/base.css', 'smc/smc-colors.css', 'smc/smc-layout.css',
  'smc/smc-reference.css', 'component/component.css', 'tokens.css'];
const token = (value) => ({ value, type: 'string' });

function fixture(t) {
  const directory = mkdtempSync(path.join(tmpdir(), 'parse-component-css-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const input = path.join(directory, 'input');
  const output = path.join(directory, 'output');
  mkdirSync(input);
  const json = (relative, data) => {
    const file = path.join(input, relative);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, JSON.stringify(data));
  };
  const parse = (source = input) => {
    const result = spawnSync(process.execPath, [path.join(repository, 'node_modules/ts-node/dist/bin.js'),
      path.join(repository, 'parse_ids_css.ts')], {
      cwd: repository, encoding: 'utf8',
      env: { ...process.env, FIGMA_INPUT_DIR: source, CSS_OUTPUT_DIR: output },
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  };
  return { directory, input, output, json, parse };
}

// Check the complete generated declaration block, including unique, valid names
// and nonempty values. Values may contain semicolons inside quoted CSS strings.
function declarations(file) {
  const text = readFileSync(file, 'utf8');
  assert.ok(text.startsWith(':root {\n') && text.endsWith('}\n'), file);
  const entries = text.slice(':root {\n'.length, -2).split('\n').filter(Boolean).map((line) => {
    const match = line.match(/^  (--ids-comp-[a-z0-9-]+): (.+);$/);
    assert.ok(match, `Invalid CSS declaration in ${file}: ${line}`);
    return [match[1], match[2]];
  });
  const values = new Map(entries);
  assert.equal(values.size, entries.length, `Duplicate declarations in ${file}`);
  return values;
}

function verifySplit(output) {
  const aggregate = declarations(path.join(output, 'component/component.css'));
  const files = readdirSync(path.join(output, 'component')).filter((name) => name.startsWith('ids-') && name.endsWith('.css')).sort();
  const union = new Map();
  for (const file of files) {
    const component = file.slice(4, -4);
    const values = declarations(path.join(output, 'component', file));
    assert.ok(values.size > 0, `Empty component file: ${file}`);
    for (const [name, value] of values) {
      assert.ok(name.startsWith(`--ids-comp-${component}-`), `${name} is in the wrong component file`);
      assert.equal(value, aggregate.get(name), `${name} differs from component.css`);
      assert.equal(union.has(name), false, `${name} occurs in multiple component files`);
      union.set(name, value);
    }
  }
  assert.deepEqual(union, aggregate, 'Split files must contain exactly the aggregate key/value pairs');
  return { aggregate, files };
}

test('existing CSS output is byte-for-byte unchanged for foundations, themes, sizes, references and imports', (t) => {
  const f = fixture(t);
  f.json('foundations/base/base.json', { base: { primary: token('#123456') } });
  f.json('foundations/smc-colors/dark.json', { smc: { color: token('#000000') } });
  f.json('foundations/smc-colors/light.json', { smc: { color: token('{base.primary}') } });
  f.json('foundations/smc-layout/small.json', { smc: { gap: token('4px') } });
  f.json('foundations/smc-reference/smc-reference.json', { smc: { reference: token('{smc.gap.small}') } });
  f.json('components/button/comp-color/component.json', { color: token('{smc.color}') });
  f.json('components/button/comp-size/comfortable.json', { width: token('{smc.reference}') });
  f.parse();
  // These fixed outputs preserve the previous parser's serialization contract.
  const expected = {
    'base/base.css': ':root {\n  --ids-base-primary: #123456;\n}\n',
    'smc/smc-colors.css': '.ids-theme-dark {\n  --ids-smc-color: #000000;\n}\n\n.ids-theme-light {\n  --ids-smc-color: var(--ids-base-primary);\n}\n',
    'smc/smc-layout.css': ':root {\n  --ids-smc-gap-small: 4px;\n}\n',
    'smc/smc-reference.css': ':root {\n  --ids-smc-reference: var(--ids-smc-gap-small);\n}\n',
    'component/component.css': ':root {\n  --ids-comp-button-color: var(--ids-smc-color);\n  --ids-comp-button-width-comfortable: var(--ids-smc-reference);\n}\n',
    'tokens.css': '/* IDS Design Token CSS - Auto-generated */\n/* Import order: foundation → component */\n\n@import "./base/base.css";\n@import "./smc/smc-colors.css";\n@import "./smc/smc-layout.css";\n@import "./smc/smc-reference.css";\n@import "./component/component.css";\n',
  };
  for (const [file, css] of Object.entries(expected)) assert.equal(readFileSync(path.join(f.output, file), 'utf8'), css, file);
  const { files } = verifySplit(f.output);
  assert.deepEqual(files, ['ids-button.css']);
  assert.equal(readFileSync(path.join(f.output, 'component/ids-button.css'), 'utf8'), expected['component/component.css']);
});

test('full component names remain separate and duplicate tokens have the aggregate value exactly once', (t) => {
  const f = fixture(t);
  const components = ['icon', 'icon-button', 'segmented-control', 'segmented-control-toggle'];
  for (const name of components) {
    f.json(`components/${name}/comp-color/component.json`, { label: token(`"${name}; label"`) });
    f.json(`components/${name}/comp-color/duplicate.json`, { label: token('duplicate') });
    f.json(`components/${name}/comp-size/dense.json`, { width: { value: 12, type: 'number' } });
  }
  f.parse();
  assert.deepEqual(verifySplit(f.output).files, components.map((name) => `ids-${name}.css`).sort());
  for (const name of components) {
    assert.deepEqual([...declarations(path.join(f.output, `component/ids-${name}.css`)).keys()].sort(),
      [`--ids-comp-${name}-label`, `--ids-comp-${name}-width-dense`]);
  }
  const before = new Map(readdirSync(path.join(f.output, 'component')).map((file) =>
    [file, readFileSync(path.join(f.output, 'component', file), 'utf8')]));
  f.parse();
  for (const [file, css] of before) assert.equal(readFileSync(path.join(f.output, 'component', file), 'utf8'), css);
  rmSync(path.join(f.input, 'components/icon-button'), { recursive: true });
  f.parse();
  assert.equal(existsSync(path.join(f.output, 'component/ids-icon-button.css')), false);
  verifySplit(f.output);
});

test('empty input and components without supported tokens leave no stale component files', (t) => {
  const f = fixture(t);
  f.json('components/button/comp-color/component.json', { label: token('red') });
  f.parse();
  f.json('components/button/comp-color/component.json', { description: 'No tokens' });
  f.parse();
  assert.deepEqual(verifySplit(f.output).files, []);
  rmSync(path.join(f.input, 'components'), { recursive: true });
  f.parse();
  assert.equal(existsSync(f.output), false);
});

test('real repository tokens split without missing or changed values and leave validation results unchanged', (t) => {
  const f = fixture(t);
  f.parse(repository);
  const { aggregate, files } = verifySplit(f.output);
  assert.ok(files.length > 0 && aggregate.size > 0);
  const legacyOnly = path.join(f.directory, 'legacy');
  for (const file of legacyFiles) {
    const target = path.join(legacyOnly, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, readFileSync(path.join(f.output, file)));
  }
  const before = filterComponentTokens(collectCustomPropertyDefinitions(legacyOnly));
  const after = filterComponentTokens(collectCustomPropertyDefinitions(f.output));
  assert.deepEqual(after, before);
  const references = new Set(aggregate.keys());
  assert.deepEqual(compareTokenSets(after, references), compareTokenSets(before, references));
});
