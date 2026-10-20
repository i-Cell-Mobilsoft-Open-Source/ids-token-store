import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { credentialResponse, resolveTarget } from './publish-css.mjs';

const script = fileURLToPath(new URL('./publish-css.sh', import.meta.url));
const defaultUrl = 'https://gitlab.example.com/team/frontend.git';
const alternateUrl = 'https://github.com/team/frontend.git';
const auth = { DEFAULT_TARGET_REPO_URL: defaultUrl,
  DEFAULT_TARGET_REPO_USERNAME: 'publisher', DEFAULT_TARGET_REPO_CREDENTIALS: 'default-secret', CI: 'true' };

test('empty target fields use the complete default pair', () => {
  const result = resolveTarget({ ...auth, PUBLISH_TARGET_PROFILE: ' ', CUSTOM_TARGET_REPO_URL: ' ' });
  assert.equal(result.mode, 'default');
  assert.equal(result.url, defaultUrl);
  assert.equal(result.token, 'default-secret');
  assert.equal(result.username, 'publisher');
  assert.equal(result.credentialName, 'DEFAULT_TARGET_REPO_CREDENTIALS');
});

test('each named profile resolves its own visible URL and secret without changing the default', () => {
  const env = { ...auth, DEMO_TARGET_REPO_URL: alternateUrl, DEMO_TARGET_REPO_CREDENTIALS: 'demo-secret',
    SANDBOX_TARGET_REPO_URL: 'https://sandbox.example/team/frontend', SANDBOX_TARGET_REPO_CREDENTIALS: 'sandbox-secret' };
  for (const profile of ['DEMO', 'SANDBOX']) {
    const result = resolveTarget({ ...env, PUBLISH_TARGET_PROFILE: profile });
    assert.equal(result.mode, 'profile');
    assert.equal(result.profile, profile);
    assert.equal(result.url, env[`${profile}_TARGET_REPO_URL`]);
    assert.equal(result.token, env[`${profile}_TARGET_REPO_CREDENTIALS`]);
    assert.equal(result.username, 'git');
    assert.equal(result.credentialName, `${profile}_TARGET_REPO_CREDENTIALS`);
  }
  assert.equal(resolveTarget(env).token, 'default-secret');
});

test('GitHub adapter supplies only the chosen profile and never mixes incomplete pairs', () => {
  const env = { ...auth, PUBLISH_TARGET_PROFILE: 'DEMO', PUBLISH_PROFILE_URL: alternateUrl,
    PUBLISH_PROFILE_CREDENTIALS: 'selected-secret', PUBLISH_PROFILE_USERNAME: 'selected-user',
    DEMO_TARGET_REPO_URL: defaultUrl, DEMO_TARGET_REPO_CREDENTIALS: 'unselected-secret' };
  const result = resolveTarget(env);
  assert.equal(result.url, alternateUrl);
  assert.equal(result.token, 'selected-secret');
  assert.equal(result.username, 'selected-user');
  assert.throws(() => resolveTarget({ ...env, PUBLISH_PROFILE_CREDENTIALS: '' }), /Missing publish token/);
  assert.throws(() => resolveTarget({ ...env, PUBLISH_PROFILE_URL: '' }), /profile has no target URL/);
});

test('unknown, invalid and incomplete profiles fail without a default fallback', () => {
  for (const profile of ['UNKNOWN', 'demo', '../DEMO', 'DEMO;echo', 'BAD-NAME']) {
    assert.throws(() => resolveTarget({ ...auth, PUBLISH_TARGET_PROFILE: profile }), /profile|PUBLISH_TARGET_PROFILE/);
  }
  assert.throws(() => resolveTarget({ ...auth, PUBLISH_TARGET_PROFILE: 'DEMO', DEMO_TARGET_REPO_URL: alternateUrl }), /DEMO_TARGET_REPO_CREDENTIALS/);
  assert.throws(() => resolveTarget({ ...auth, PUBLISH_TARGET_PROFILE: 'DEMO', DEMO_TARGET_REPO_CREDENTIALS: 'demo-secret' }), /profile has no target URL/);
});

test('custom targets use only the explicitly supplied URL/token pair, on any HTTPS server', () => {
  for (const url of [alternateUrl, alternateUrl.replace(/\.git$/, ''),
    'https://another.example/team/frontend.git', 'https://gitlab.example.com/team/other.git']) {
    const result = resolveTarget({ ...auth, CUSTOM_TARGET_REPO_URL: url,
      CUSTOM_TARGET_REPO_CREDENTIALS: 'custom-secret', CUSTOM_TARGET_REPO_USERNAME: 'custom-user' });
    assert.equal(result.mode, 'custom');
    assert.equal(result.url, url);
    assert.equal(result.token, 'custom-secret');
    assert.equal(result.username, 'custom-user');
  }
  assert.equal(resolveTarget({ CUSTOM_TARGET_REPO_URL: alternateUrl,
    CUSTOM_TARGET_REPO_CREDENTIALS: 'custom-secret', CI: 'true' }).url, alternateUrl);
});

test('clone endpoints without .git are preserved for default, profile and custom targets', () => {
  for (const url of ['https://dev.azure.com/team/project/_git/frontend',
    'https://git-codecommit.us-east-2.amazonaws.com/v1/repos/frontend']) {
    assert.equal(resolveTarget({ ...auth, DEFAULT_TARGET_REPO_URL: url }).url, url);
    assert.equal(resolveTarget({ ...auth, PUBLISH_TARGET_PROFILE: 'DEMO',
      DEMO_TARGET_REPO_URL: url, DEMO_TARGET_REPO_CREDENTIALS: 'demo-secret' }).url, url);
    assert.equal(resolveTarget({ ...auth, CUSTOM_TARGET_REPO_URL: url,
      CUSTOM_TARGET_REPO_CREDENTIALS: 'custom-secret' }).url, url);
  }
});

test('custom URL or token alone never borrows the other half from the default pair', () => {
  for (const settings of [{ CUSTOM_TARGET_REPO_URL: alternateUrl },
    { CUSTOM_TARGET_REPO_CREDENTIALS: 'custom-secret' }, { CUSTOM_TARGET_REPO_USERNAME: 'custom-user' },
    { CUSTOM_TARGET_REPO_URL: alternateUrl, CUSTOM_TARGET_REPO_CREDENTIALS: ' ' }]) {
    assert.throws(() => resolveTarget({ ...auth, ...settings }), /Custom publishing requires|empty token/);
  }
});

test('profile selection conflicts with every custom target field', () => {
  for (const settings of [{ CUSTOM_TARGET_REPO_URL: alternateUrl },
    { CUSTOM_TARGET_REPO_CREDENTIALS: 'custom-secret' }, { CUSTOM_TARGET_REPO_USERNAME: 'custom-user' }]) {
    assert.throws(() => resolveTarget({ ...auth, PUBLISH_TARGET_PROFILE: 'DEMO', ...settings }), /not both/);
  }
});

test('old URL/JSON credential settings are not used as compatibility fallbacks', () => {
  assert.throws(() => resolveTarget({ CI: 'true', TARGET_REPO_URL: defaultUrl,
    TARGET_REPO_CREDENTIALS: JSON.stringify({ origin: 'https://gitlab.example.com', username: 'old', token: 'old-secret' }) }), /DEFAULT_TARGET_REPO_URL/);
  assert.throws(() => resolveTarget({ ...auth, DEFAULT_TARGET_REPO_CREDENTIALS: '', TARGET_REPO_TOKEN: 'old-secret' }), /Missing publish token/);
});

test('malformed and credential-bearing URLs are rejected in all three modes without echoing input', () => {
  for (const url of ['not-a-url', 'http://github.com/team/repo', 'ssh://git@github.com/team/repo',
    'https://user:secret@github.com/team/repo', 'https://github.com/team/repo?secret=secret',
    'https://github.com/team/repo#secret', 'https://github.com/team/../repo',
    'https://github.com/team/%2e%2e/repo', 'https://github.com/team/repo\\secret']) {
    for (const env of [{ ...auth, DEFAULT_TARGET_REPO_URL: url },
      { ...auth, PUBLISH_TARGET_PROFILE: 'DEMO', DEMO_TARGET_REPO_URL: url, DEMO_TARGET_REPO_CREDENTIALS: 'demo-secret' },
      { ...auth, CUSTOM_TARGET_REPO_URL: url, CUSTOM_TARGET_REPO_CREDENTIALS: 'custom-secret' }]) {
      assert.throws(() => resolveTarget(env), (error) => !error.message.includes('secret@') && /URL|token/.test(error.message));
    }
  }
});

test('network targets require tokens; CI disallows file transport and invalid credentials', () => {
  assert.throws(() => resolveTarget({ CI: 'true', DEFAULT_TARGET_REPO_URL: defaultUrl }), /Missing publish token/);
  assert.throws(() => resolveTarget({ ...auth, DEFAULT_TARGET_REPO_URL: 'file:///tmp/repo.git' }), /HTTPS/);
  assert.throws(() => resolveTarget({ ...auth, DEFAULT_TARGET_REPO_USERNAME: 'bad\nusername' }), /line breaks/);
  assert.throws(() => resolveTarget({ ...auth, DEFAULT_TARGET_REPO_CREDENTIALS: 'secret\npassword=injected' }), /line breaks/);
});

test('credential helper answers only the exact HTTPS host and repository path', () => {
  const env = { PUBLISH_CREDENTIAL_URL: alternateUrl, PUBLISH_CREDENTIAL_USERNAME: 'publisher', PUBLISH_CREDENTIAL_TOKEN: 'test-secret' };
  const request = 'protocol=https\nhost=github.com\npath=team/frontend.git\n\n';
  assert.equal(credentialResponse(request, env), 'username=publisher\npassword=test-secret\n\n');
  for (const input of [request.replace('https', 'http'), request.replace('github.com', 'evil.example'),
    request.replace('frontend.git', 'other.git'), 'protocol=https\nhost=github.com\n\n']) {
    assert.equal(credentialResponse(input, env), '');
  }
});

function git(cwd, ...args) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.invalid',
    GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.invalid' } });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}

function fixture(t) {
  const root = mkdtempSync(path.join(tmpdir(), 'publish-css-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = path.join(root, 'source');
  const bare = path.join(root, 'default.git');
  const other = path.join(root, 'other.git');
  const seed = path.join(root, 'seed');
  mkdirSync(source); mkdirSync(seed); mkdirSync(path.join(source, 'ids_css'));
  writeFileSync(path.join(source, 'ids_css', 'tokens.css'), ':root { --ids-comp-test: 1px; }\n');
  git(root, 'init', '--bare', '--initial-branch=main', bare);
  git(root, 'init', '--bare', '--initial-branch=main', other);
  git(seed, 'init', '--initial-branch=main');
  writeFileSync(path.join(seed, 'README.md'), 'Keep this file\n');
  git(seed, 'add', '.'); git(seed, 'commit', '-m', 'Initial target');
  git(seed, 'push', bare, 'main'); git(seed, 'push', other, 'main');
  // Real CI profile secrets must not affect the credential-free local fixtures.
  const inheritedEnv = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(?:[A-Z][A-Z0-9_]*_TARGET_REPO|PUBLISH_PROFILE)_(?:URL|CREDENTIALS|USERNAME)$/.test(key)));
  const env = { ...inheritedEnv, CI: '', GITHUB_ACTIONS: '', GITLAB_CI: '',
    SKIP_PARSE: 'true', CSS_OUTPUT_DIR: '', DEFAULT_TARGET_REPO_URL: bare,
    DEFAULT_TARGET_REPO_CREDENTIALS: '', DEFAULT_TARGET_REPO_USERNAME: '',
    PUBLISH_TARGET_PROFILE: '', CUSTOM_TARGET_REPO_URL: '', CUSTOM_TARGET_REPO_CREDENTIALS: '', CUSTOM_TARGET_REPO_USERNAME: '',
    TARGET_REPO_BRANCH: '', TARGET_CSS_PATH: '', TARGET_CHECKOUT_DIR: '', TARGET_COMMIT_MESSAGE: '',
    GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '' };
  const run = (extra = {}) => spawnSync('bash', [script], { cwd: source, env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, source, bare, other, seed, env, run };
}

const defaultCss = 'projects/demo/src/assets/ids_css/tokens.css';

test('real clone/commit/push uses the fallback, preserves other files, and is idempotent', (t) => {
  const f = fixture(t);
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /Publish mode: default/);
  assert.ok(result.stdout.includes(f.bare));
  assert.match(result.stdout, /Credential setting: DEFAULT_TARGET_REPO_CREDENTIALS/);
  assert.match(git(f.root, '--git-dir', f.bare, 'show', `IDS_CSS:${defaultCss}`), /--ids-comp-test/);
  assert.equal(git(f.root, '--git-dir', f.bare, 'show', 'IDS_CSS:README.md'), 'Keep this file');
  const first = git(f.root, '--git-dir', f.bare, 'rev-parse', 'IDS_CSS');
  result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already contains/);
  assert.equal(git(f.root, '--git-dir', f.bare, 'rev-parse', 'IDS_CSS'), first);
});

for (const mode of ['profile', 'custom']) test(`${mode} target receives CSS with branch/path options and does not change the default`, (t) => {
  const f = fixture(t);
  const settings = { ...(mode === 'profile' ? { PUBLISH_TARGET_PROFILE: 'DEMO', DEMO_TARGET_REPO_URL: f.other } : { CUSTOM_TARGET_REPO_URL: f.other }),
    TARGET_REPO_BRANCH: 'release/css', TARGET_CSS_PATH: 'styles/generated', TARGET_CHECKOUT_DIR: 'custom-checkout' };
  let result = f.run(settings);
  assert.equal(result.status, 0, result.stderr);
  assert.ok(result.stdout.includes(`Publish mode: ${mode}`));
  assert.ok(result.stdout.includes(f.other));
  assert.ok(result.stdout.includes(mode === 'profile' ? 'DEMO_TARGET_REPO_CREDENTIALS' : 'CUSTOM_TARGET_REPO_CREDENTIALS'));
  assert.match(git(f.root, '--git-dir', f.other, 'show', 'release/css:styles/generated/tokens.css'), /--ids-comp-test/);
  assert.equal(git(f.root, '--git-dir', f.bare, 'branch', '--list', 'IDS_CSS'), '');
  writeFileSync(path.join(f.source, 'ids_css', 'tokens.css'), ':root { --ids-comp-test: 2px; }');
  result = f.run(settings);
  assert.equal(result.status, 0, result.stderr);
  assert.match(git(f.root, '--git-dir', f.other, 'show', 'release/css:styles/generated/tokens.css'), /2px/);
  result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(git(f.root, '--git-dir', f.bare, 'show', `IDS_CSS:${defaultCss}`), /2px/);
});

test('nonexistent repository and rejected push fail clearly', (t) => {
  const f = fixture(t);
  let result = f.run({ DEFAULT_TARGET_REPO_URL: path.join(f.root, 'missing.git') });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot clone target repository/);
  writeFileSync(path.join(f.bare, 'hooks', 'pre-receive'), '#!/bin/sh\necho remote-secret >&2\nexit 1\n', { mode: 0o755 });
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Cannot push CSS/);
  assert.ok(!result.stderr.includes('remote-secret'));
});

test('missing pipeline artifact, unsafe paths, invalid branch and symlinks cannot publish', (t) => {
  const f = fixture(t);
  let result = f.run({ CSS_OUTPUT_DIR: 'missing' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /artifact is missing/);
  for (const values of [{ TARGET_CSS_PATH: '../outside' }, { TARGET_CSS_PATH: '.git' },
    { TARGET_CHECKOUT_DIR: '.' }, { TARGET_CHECKOUT_DIR: 'ids_css' }, { TARGET_REPO_BRANCH: 'bad branch' }]) {
    result = f.run(values);
    assert.notEqual(result.status, 0);
  }
  symlinkSync(f.seed, path.join(f.source, 'linked'));
  result = f.run({ TARGET_CHECKOUT_DIR: 'linked/checkout' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic links/);
  symlinkSync(path.join(f.seed, 'README.md'), path.join(f.source, 'ids_css', 'unsafe.css'));
  result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /regular files/);
});

test('custom secrets and raw invalid URL never appear in CLI logs', (t) => {
  const f = fixture(t);
  const result = f.run({ CI: 'true', CUSTOM_TARGET_REPO_URL: 'https://publisher:never-log-this@evil.example/a/b',
    CUSTOM_TARGET_REPO_CREDENTIALS: 'never-log-this' });
  assert.notEqual(result.status, 0);
  assert.ok(!(result.stdout + result.stderr).includes('never-log-this'));
  assert.ok(!(result.stdout + result.stderr).includes('evil.example'));
});

test('incomplete or conflicting input fails before Git starts and never logs any token', (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, 'bin');
  const marker = path.join(f.root, 'git-invoked');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.GIT_INVOCATION_MARKER, "invoked"); process.exit(99);\n', { mode: 0o755 });
  for (const settings of [{ CUSTOM_TARGET_REPO_URL: alternateUrl },
    { CUSTOM_TARGET_REPO_CREDENTIALS: 'custom-secret' },
    { PUBLISH_TARGET_PROFILE: 'UNKNOWN' },
    { PUBLISH_TARGET_PROFILE: 'DEMO', CUSTOM_TARGET_REPO_CREDENTIALS: 'custom-secret' },
    { CUSTOM_TARGET_REPO_URL: alternateUrl, CUSTOM_TARGET_REPO_CREDENTIALS: 'secret\npassword=injected' }]) {
    const result = f.run({ ...auth, ...settings, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GIT_INVOCATION_MARKER: marker });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false);
    assert.ok(!/(default-secret|custom-secret|password=injected)/.test(result.stdout + result.stderr));
  }
});

test('real Git credential protocol invokes the helper and refuses other repository paths', () => {
  const helperPath = fileURLToPath(new URL('./publish-css.mjs', import.meta.url));
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const args = ['-c', 'credential.helper=', '-c',
    `credential.helper=!${quote(process.execPath)} ${quote(helperPath)} --credential`,
    '-c', 'credential.useHttpPath=true', 'credential', 'fill'];
  const env = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_TERMINAL_PROMPT: '0', PUBLISH_CREDENTIAL_URL: alternateUrl,
    PUBLISH_CREDENTIAL_USERNAME: 'publisher', PUBLISH_CREDENTIAL_TOKEN: 'protocol-secret' };
  let result = spawnSync('git', args, { env, encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\npath=team/frontend.git\n\n' });
  assert.equal(result.status, 0);
  assert.match(result.stdout, /password=protocol-secret/);
  result = spawnSync('git', args, { env, encoding: 'utf8',
    input: 'protocol=https\nhost=github.com\npath=team/other.git\n\n' });
  assert.notEqual(result.status, 0);
  assert.ok(!result.stdout.includes('protocol-secret'));
});

test('target repository cannot redirect CSS replacement through a committed symlink', (t) => {
  const f = fixture(t);
  symlinkSync(f.source, path.join(f.seed, 'projects'));
  git(f.seed, 'add', 'projects'); git(f.seed, 'commit', '-m', 'Unsafe target path');
  git(f.seed, 'push', f.bare, 'main');
  const result = f.run();
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /symbolic links/);
  assert.match(readFileSync(path.join(f.source, 'ids_css', 'tokens.css'), 'utf8'), /--ids-comp-test/);
});
