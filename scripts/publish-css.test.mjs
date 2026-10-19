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
const auth = { TARGET_REPO_USERNAME: 'publisher', TARGET_REPO_TOKEN: 'test-secret', CI: 'true' };
const credentialsFor = (origin) => JSON.stringify({ origin, username: 'publisher', token: 'server-specific-secret' });

test('empty override preserves the configured default and branch/path are independent', () => {
  const result = resolveTarget({ ...auth, TARGET_REPO_URL: defaultUrl, PUBLISH_TARGET_REPO_URL: '  ' });
  assert.equal(result.url, defaultUrl);
  assert.equal(result.token, 'test-secret');
});

test('a new destination is used without registration, with or without .git suffix', () => {
  for (const url of [alternateUrl, alternateUrl.replace(/\.git$/, '')]) {
    const result = resolveTarget({ ...auth, TARGET_REPO_URL: defaultUrl,
      PUBLISH_TARGET_REPO_URL: url, TARGET_REPO_CREDENTIALS: credentialsFor('https://github.com') });
    assert.equal(result.url, url);
  }
});

test('any valid HTTPS destination accepts credentials belonging to its server', () => {
  for (const url of ['https://another.example/team/frontend.git',
    'https://gitlab.example.com/team/other.git', 'https://github.com.example/team/frontend.git',
    'https://github.com/team/frontend.git/other']) {
    const target = resolveTarget({ ...auth, TARGET_REPO_URL: defaultUrl,
      PUBLISH_TARGET_REPO_URL: url, TARGET_REPO_CREDENTIALS: credentialsFor(new URL(url).origin) });
    assert.equal(target.url, url);
    assert.equal(target.token, 'server-specific-secret');
  }
});

test('clone endpoints without a .git suffix are preserved for default and manual destinations', () => {
  for (const url of ['https://dev.azure.com/team/project/_git/frontend',
    'https://git-codecommit.us-east-2.amazonaws.com/v1/repos/frontend']) {
    const credentials = credentialsFor(new URL(url).origin);
    assert.equal(resolveTarget({ CI: 'true', TARGET_REPO_URL: url,
      TARGET_REPO_CREDENTIALS: credentials }).url, url);
    assert.equal(resolveTarget({ CI: 'true', TARGET_REPO_URL: defaultUrl,
      PUBLISH_TARGET_REPO_URL: url, TARGET_REPO_CREDENTIALS: credentials }).url, url);
  }
});

test('default credentials work for other repositories on the same server but never cross origins', () => {
  const target = resolveTarget({ ...auth, TARGET_REPO_URL: defaultUrl,
    PUBLISH_TARGET_REPO_URL: 'https://gitlab.example.com/another/frontend.git' });
  assert.equal(target.token, 'test-secret');
  for (const url of [alternateUrl, 'https://gitlab.example.com:8443/team/frontend.git',
    'https://gitlab.example.com.other/team/frontend.git']) {
    assert.throws(() => resolveTarget({ ...auth, TARGET_REPO_URL: defaultUrl,
      PUBLISH_TARGET_REPO_URL: url }), /Missing publish credentials for the selected server/);
  }
});

test('explicit credential secret has no fallback on a different server or invalid configuration', () => {
  for (const value of ['not-json-secret', '{}', JSON.stringify({ origin: 'http://github.com', username: 'publisher', token: 'secret' }),
    JSON.stringify({ origin: 'https://user:secret@github.com', username: 'publisher', token: 'secret' }),
    JSON.stringify({ origin: 'https://github.com/team', username: 'publisher', token: 'secret' })]) {
    assert.throws(() => resolveTarget({ ...auth, TARGET_REPO_URL: defaultUrl,
      TARGET_REPO_CREDENTIALS: value }), (error) => !error.message.includes('not-json-secret') && /TARGET_REPO_CREDENTIALS/.test(error.message));
  }
  assert.throws(() => resolveTarget({ ...auth, TARGET_REPO_URL: defaultUrl,
    PUBLISH_TARGET_REPO_URL: 'https://third.example/team/repo.git',
    TARGET_REPO_CREDENTIALS: credentialsFor('https://github.com') }), /No matching credentials/);
  assert.equal(resolveTarget({ ...auth, TARGET_REPO_URL: defaultUrl,
    TARGET_REPO_CREDENTIALS: credentialsFor('https://github.com') }).token, 'test-secret');
  // Supplying a token without a known issuer is insufficient when no default exists.
  assert.throws(() => resolveTarget({ ...auth, PUBLISH_TARGET_REPO_URL: alternateUrl }), /Missing publish credentials/);
  assert.equal(resolveTarget({ CI: 'true', PUBLISH_TARGET_REPO_URL: alternateUrl,
    TARGET_REPO_CREDENTIALS: credentialsFor('https://github.com') }).url, alternateUrl);
});

test('malformed and credential-bearing manual URLs are rejected without echoing input', () => {
  for (const url of ['not-a-url', 'http://github.com/team/repo', 'ssh://git@github.com/team/repo',
    'https://user:secret@github.com/team/repo', 'https://github.com/team/repo?secret=secret',
    'https://github.com/team/repo#secret', 'https://github.com/team/../repo',
    'https://github.com/team/%2e%2e/repo', 'https://github.com/team/repo\\secret']) {
    assert.throws(() => resolveTarget({ ...auth, PUBLISH_TARGET_REPO_URL: url }), (error) => {
      assert.ok(!error.message.includes('secret@'));
      return /URL|credentials/.test(error.message);
    });
  }
});

test('legacy default credentials are extracted and never transferred to a different repository', () => {
  const legacy = 'https://publisher:old-secret@gitlab.example.com/team/frontend.git';
  assert.deepEqual(resolveTarget({ CI: 'true', TARGET_REPO_URL: legacy }),
    { url: defaultUrl, username: 'publisher', token: 'old-secret' });
  assert.throws(() => resolveTarget({ CI: 'true', TARGET_REPO_URL: legacy,
    PUBLISH_TARGET_REPO_URL: alternateUrl }), /Missing publish credentials/);
});

test('CI requires credentials and disallows file transport; incomplete credentials fail', () => {
  assert.throws(() => resolveTarget({ CI: 'true', TARGET_REPO_URL: defaultUrl }), /Missing publish credentials/);
  assert.throws(() => resolveTarget({ ...auth, TARGET_REPO_TOKEN: '', TARGET_REPO_URL: defaultUrl }), /both/);
  assert.throws(() => resolveTarget({ ...auth, TARGET_REPO_URL: 'file:///tmp/repo.git' }), /HTTPS/);
  assert.throws(() => resolveTarget({ ...auth, TARGET_REPO_USERNAME: 'bad\nusername', TARGET_REPO_URL: defaultUrl }), /both/);
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
  const env = { ...process.env, CI: '', GITHUB_ACTIONS: '', GITLAB_CI: '',
    SKIP_PARSE: 'true', CSS_OUTPUT_DIR: '', TARGET_REPO_URL: bare,
    PUBLISH_TARGET_REPO_URL: '', TARGET_REPO_CREDENTIALS: '',
    TARGET_REPO_USERNAME: '', TARGET_REPO_TOKEN: '', TARGET_REPO_BRANCH: '',
    TARGET_CSS_PATH: '', TARGET_CHECKOUT_DIR: '', TARGET_COMMIT_MESSAGE: '',
    GIT_AUTHOR_NAME: '', GIT_AUTHOR_EMAIL: '' };
  const run = (extra = {}) => spawnSync('bash', [script], { cwd: source, env: { ...env, ...extra }, encoding: 'utf8' });
  return { root, source, bare, other, seed, env, run };
}

const defaultCss = 'projects/demo/src/assets/ids_css/tokens.css';

test('real clone/commit/push uses the fallback, preserves other files, and is idempotent', (t) => {
  const f = fixture(t);
  let result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(git(f.root, '--git-dir', f.bare, 'show', `IDS_CSS:${defaultCss}`), /--ids-comp-test/);
  assert.equal(git(f.root, '--git-dir', f.bare, 'show', 'IDS_CSS:README.md'), 'Keep this file');
  const first = git(f.root, '--git-dir', f.bare, 'rev-parse', 'IDS_CSS');
  result = f.run();
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /already contains/);
  assert.equal(git(f.root, '--git-dir', f.bare, 'rev-parse', 'IDS_CSS'), first);
});

test('unregistered alternative receives CSS with existing branch/path options; default is untouched', (t) => {
  const f = fixture(t);
  const settings = { PUBLISH_TARGET_REPO_URL: f.other,
    TARGET_REPO_BRANCH: 'release/css', TARGET_CSS_PATH: 'styles/generated', TARGET_CHECKOUT_DIR: 'custom-checkout' };
  let result = f.run(settings);
  assert.equal(result.status, 0, result.stderr);
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
  let result = f.run({ TARGET_REPO_URL: path.join(f.root, 'missing.git') });
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

test('legacy secrets and raw invalid URL never appear in CLI logs', (t) => {
  const f = fixture(t);
  const result = f.run({ CI: 'true', TARGET_REPO_URL: defaultUrl,
    PUBLISH_TARGET_REPO_URL: 'https://publisher:never-log-this@evil.example/a/b' });
  assert.notEqual(result.status, 0);
  assert.ok(!(result.stdout + result.stderr).includes('never-log-this'));
  assert.ok(!(result.stdout + result.stderr).includes('evil.example'));
});

test('a manual URL cannot send an unrelated token or malformed credential secret to Git', (t) => {
  const f = fixture(t);
  const bin = path.join(f.root, 'bin');
  const marker = path.join(f.root, 'git-invoked');
  mkdirSync(bin);
  writeFileSync(path.join(bin, 'git'), '#!/usr/bin/env node\nrequire("node:fs").writeFileSync(process.env.GIT_INVOCATION_MARKER, "invoked"); process.exit(99);\n', { mode: 0o755 });
  for (const secret of ['', credentialsFor('https://another.example'), 'never-log-malformed-secret',
    JSON.stringify({ origin: 'https://selected.example', username: 'publisher', token: 'secret\npassword=injected' })]) {
    const result = f.run({ ...auth, TARGET_REPO_URL: defaultUrl,
      PUBLISH_TARGET_REPO_URL: 'https://selected.example/team/frontend.git',
      TARGET_REPO_CREDENTIALS: secret, PATH: `${bin}${path.delimiter}${process.env.PATH}`,
      GIT_INVOCATION_MARKER: marker });
    assert.notEqual(result.status, 0);
    assert.equal(existsSync(marker), false, 'Invalid credential scope must fail before Git starts');
    assert.ok(!/(test-secret|server-specific-secret|never-log-malformed-secret|password=injected)/.test(result.stdout + result.stderr));
  }
});

test('existing SSH default remains usable with a deploy key, without forwarding HTTPS tokens', () => {
  assert.deepEqual(resolveTarget({ CI: 'true', TARGET_REPO_URL: 'git@gitlab.example.com:team/frontend.git' }),
    { url: 'ssh://git@gitlab.example.com/team/frontend.git', username: '', token: '' });
  assert.throws(() => resolveTarget({ ...auth, TARGET_REPO_URL: 'git@gitlab.example.com:team/frontend.git' }), /deploy key/);
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
