// These tests exercise routing expressions from the checked-in configuration.
// They do not simulate a hosted Actions runner or a GitLab scheduler.
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { resolveTarget } from './publish-css.mjs';
import vm from 'node:vm';
import test from 'node:test';

const github = readFileSync(new URL('../.github/workflows/tokens.yml', import.meta.url), 'utf8');
const gitlab = readFileSync(new URL('../.gitlab-ci.yml', import.meta.url), 'utf8');
const ghJob = (name) => github.match(new RegExp(`^  ${name}:\\n([\\s\\S]*?)(?=^  [a-z_]+:|$(?![\\s\\S]))`, 'm'))?.[1];
const glJob = (name) => gitlab.match(new RegExp(`^${name}:\\n([\\s\\S]*?)(?=^[a-z_]+:|$(?![\\s\\S]))`, 'm'))?.[1];
function runs(name, event, operation) {
  const job = ghJob(name);
  assert.ok(job, `Missing job ${name}`);
  const condition = job.match(/^    if: (.+)$/m)?.[1];
  return condition ? vm.runInNewContext(condition, { github: { event_name: event }, inputs: { operation } }) : true;
}

test('GitHub push generates CSS and can never select validation or publish', () => {
  for (const operation of [undefined, 'generate', 'validate', 'publish']) {
    assert.equal(runs('parse_tokens', 'push', operation), true);
    assert.equal(runs('publish_tokens', 'push', operation), false);
    assert.equal(runs('validate_ids_styles_tokens', 'push', operation), false);
  }
});

test('GitHub dispatch selects only the explicit manual operation', () => {
  for (const operation of ['generate', 'validate', 'publish']) {
    assert.equal(runs('parse_tokens', 'workflow_dispatch', operation), true);
    assert.equal(runs('publish_tokens', 'workflow_dispatch', operation), operation === 'publish');
    assert.equal(runs('validate_ids_styles_tokens', 'workflow_dispatch', operation), operation === 'validate');
  }
  assert.match(github, /default: generate/);
});

test('publish and validation independently consume CSS from the same workflow run', () => {
  for (const job of ['publish_tokens', 'validate_ids_styles_tokens']) {
    const body = ghJob(job);
    assert.match(body, /needs: parse_tokens/);
    assert.match(body, /actions\/download-artifact@v4/);
    assert.doesNotMatch(body, /run-id:|needs:.*validate|needs:.*publish/);
  }
  assert.doesNotMatch(ghJob('publish_tokens'), /continue-on-error/);
  assert.match(ghJob('publish_tokens'), /persist-credentials: false/);
  assert.match(ghJob('publish_tokens'), /DEFAULT_TARGET_REPO_CREDENTIALS: \$\{\{ secrets.DEFAULT_TARGET_REPO_CREDENTIALS \}\}/);
  assert.match(ghJob('publish_tokens'), /CUSTOM_TARGET_REPO_CREDENTIALS: \$\{\{ inputs.custom_target_repo_credentials \}\}/);
  assert.match(ghJob('validate_ids_styles_tokens'), /inputs.ids_styles_ref \|\| vars.IDS_STYLES_REF/);
});

test('GitLab publish remains manual in automatic and web pipelines, independent of validation', () => {
  assert.match(gitlab, /CI_PIPELINE_SOURCE == "push"/);
  assert.match(gitlab, /CI_PIPELINE_SOURCE == "web"/);
  assert.doesNotMatch(glJob('parse_tokens'), /when: manual/);
  const publish = glJob('publish_tokens');
  assert.match(publish, /when: manual/);
  assert.match(publish, /job: parse_tokens\n\s+artifacts: true/);
  assert.match(publish, /SKIP_PARSE: "true"/);
  assert.doesNotMatch(publish, /validate_ids_styles_tokens/);
  const validation = glJob('validate_ids_styles_tokens');
  assert.match(validation, /needs: \[\]/);
  assert.match(validation, /CI_PIPELINE_SOURCE == "web"/);
  assert.match(validation, /when: manual/);
  assert.match(validation, /allow_failure: false/);
  assert.match(validation, /when: always/);
  assert.match(validation, /token-diff-report.json/);
  for (const key of ['PUBLISH_TARGET_PROFILE', 'CUSTOM_TARGET_REPO_URL', 'CUSTOM_TARGET_REPO_CREDENTIALS', 'CUSTOM_TARGET_REPO_USERNAME']) {
    assert.match(gitlab, new RegExp(`${key}:\\n\\s+value: \"\"`));
  }
});

test('source CSS commits skip protected branches, rulesets and tags using GitHub context', () => {
  const body = ghJob('parse_tokens');
  const expression = body.match(/CI_COMMIT_REF_PROTECTED: \$\{\{(.+?)\}\}/)?.[1];
  assert.ok(expression, 'Source commit protection must use GitHub context');
  assert.doesNotMatch(body, /gh api/);
  for (const [refType, protectedRef, expected] of [
    ['branch', true, true], ['branch', false, false],
    ['tag', false, true], ['tag', true, true],
  ]) {
    assert.equal(vm.runInNewContext(expression, {
      github: { ref_type: refType, ref_protected: protectedRef },
    }), expected);
  }
});

function githubPublishEnv(inputs) {
  const context = {
    vars: { DEFAULT_TARGET_REPO_URL: 'https://gitlab.example.com/team/default.git',
      DEMO_TARGET_REPO_URL: 'https://github.com/team/demo.git',
      SANDBOX_TARGET_REPO_URL: 'https://sandbox.example.com/team/frontend.git' },
    secrets: { DEFAULT_TARGET_REPO_CREDENTIALS: 'default-secret', DEMO_TARGET_REPO_CREDENTIALS: 'demo-secret',
      SANDBOX_TARGET_REPO_CREDENTIALS: 'sandbox-secret' },
    inputs: { target_profile: '', custom_target_repo_url: '', custom_target_repo_credentials: '', custom_target_repo_username: '', ...inputs },
    format: (template, value) => template.replace('{0}', value),
  };
  const env = { CI: 'true' };
  for (const key of ['DEFAULT_TARGET_REPO_URL', 'DEFAULT_TARGET_REPO_CREDENTIALS', 'DEFAULT_TARGET_REPO_USERNAME',
    'PUBLISH_TARGET_PROFILE', 'PUBLISH_PROFILE_URL', 'PUBLISH_PROFILE_CREDENTIALS', 'PUBLISH_PROFILE_USERNAME',
    'CUSTOM_TARGET_REPO_URL', 'CUSTOM_TARGET_REPO_CREDENTIALS', 'CUSTOM_TARGET_REPO_USERNAME']) {
    const expression = ghJob('publish_tokens').match(new RegExp(`^          ${key}: \\$\\{\\{(.+?)\\}\\}`, 'm'))?.[1];
    assert.ok(expression, `Missing GitHub adapter parameter ${key}`);
    env[key] = vm.runInNewContext(expression, context) || '';
  }
  return env;
}

test('GitHub adapter selects default, multiple saved profiles and custom credentials from actual workflow expressions', () => {
  assert.equal(resolveTarget(githubPublishEnv({})).token, 'default-secret');
  for (const profile of ['DEMO', 'SANDBOX']) {
    const result = resolveTarget(githubPublishEnv({ target_profile: profile }));
    assert.equal(result.profile, profile);
    assert.equal(result.token, `${profile.toLowerCase()}-secret`);
  }
  const custom = resolveTarget(githubPublishEnv({ custom_target_repo_url: 'https://custom.example/team/frontend.git',
    custom_target_repo_credentials: 'custom-secret' }));
  assert.equal(custom.mode, 'custom');
  assert.equal(custom.token, 'custom-secret');
  assert.throws(() => resolveTarget(githubPublishEnv({ target_profile: 'UNKNOWN' })), /profile has no target URL/);
  assert.throws(() => resolveTarget(githubPublishEnv({ custom_target_repo_url: 'https://custom.example/team/frontend.git' })), /requires both/);
});

test('GitHub masks the custom token before any step can display it in environment values', (t) => {
  const body = ghJob('publish_tokens');
  const marker = body.indexOf('- name: Mask custom publish token in logs');
  assert.ok(marker >= 0);
  assert.doesNotMatch(body.slice(0, marker), /- name:/);
  const block = body.slice(marker, body.indexOf('- name: Checkout', marker));
  assert.doesNotMatch(block, /env:|\$\{\{ inputs\./);
  const command = block.split('run: |\n')[1].split('\n').filter((line) => line.startsWith('          '))
    .map((line) => line.slice(10)).join('\n');
  const directory = mkdtempSync(path.join(tmpdir(), 'publish-mask-test-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const eventPath = path.join(directory, 'event.json');
  writeFileSync(eventPath, JSON.stringify({ inputs: { custom_target_repo_credentials: 'one-off%token\r\nsecond-line' } }));
  const result = spawnSync('bash', ['-c', command], { env: { ...process.env, GITHUB_EVENT_PATH: eventPath }, encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, '::add-mask::one-off%25token%0D%0Asecond-line\n');
});
