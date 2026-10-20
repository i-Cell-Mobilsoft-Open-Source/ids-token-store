// These tests exercise routing expressions from the checked-in configuration.
// They do not simulate a hosted Actions runner or a GitLab scheduler.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(publish, /environment:\n\s+name: publish-tokens/);
  assert.match(publish, /allow_failure: true/);
  assert.doesNotMatch(publish, /validate_ids_styles_tokens/);
  const validation = glJob('validate_ids_styles_tokens');
  assert.match(validation, /needs: \[\]/);
  assert.match(validation, /CI_PIPELINE_SOURCE == "web"/);
  assert.match(validation, /when: manual/);
  assert.match(validation, /allow_failure: false/);
  assert.match(validation, /when: always/);
  assert.match(validation, /token-diff-report.json/);
  assert.match(gitlab, /PUBLISH_TARGET_PROFILE:\n\s+value: ""/);
  assert.match(glJob('parse_tokens'), /ids_css\//);
  assert.match(glJob('parse_tokens'), /expire_in: 7 days/);
  assert.match(validation, /expire_in: 7 days/);
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

function githubPublishEnv(inputs, { vars = {}, secrets = {} } = {}) {
  const context = {
    vars: { DEFAULT_TARGET_REPO_URL: 'https://gitlab.example.com/team/default.git',
      DEMO_TARGET_REPO_URL: 'https://github.com/team/demo.git',
      SANDBOX_TARGET_REPO_URL: 'https://sandbox.example.com/team/frontend.git', ...vars },
    secrets: { DEFAULT_TARGET_REPO_CREDENTIALS: 'default-secret', DEMO_TARGET_REPO_CREDENTIALS: 'demo-secret',
      SANDBOX_TARGET_REPO_CREDENTIALS: 'sandbox-secret', ...secrets },
    inputs: { target_profile: '', ...inputs },
    format: (template, value) => template.replace('{0}', value),
  };
  const env = { CI: 'true' };
  for (const key of ['DEFAULT_TARGET_REPO_URL', 'DEFAULT_TARGET_REPO_CREDENTIALS', 'DEFAULT_TARGET_REPO_USERNAME',
    'PUBLISH_TARGET_PROFILE', 'PUBLISH_PROFILE_URL', 'PUBLISH_PROFILE_CREDENTIALS', 'PUBLISH_PROFILE_USERNAME']) {
    const expression = ghJob('publish_tokens').match(new RegExp(`^          ${key}: \\$\\{\\{(.+?)\\}\\}`, 'm'))?.[1];
    assert.ok(expression, `Missing GitHub adapter parameter ${key}`);
    env[key] = vm.runInNewContext(expression, context) || '';
  }
  return env;
}

test('GitHub adapter selects default and multiple saved profiles from actual workflow expressions without fallback', () => {
  const defaultTarget = resolveTarget(githubPublishEnv({}));
  assert.equal(defaultTarget.url, 'https://gitlab.example.com/team/default.git');
  assert.equal(defaultTarget.token, 'default-secret');
  for (const profile of ['DEMO', 'SANDBOX']) {
    const result = resolveTarget(githubPublishEnv({ target_profile: profile }));
    assert.equal(result.profile, profile);
    assert.equal(result.token, `${profile.toLowerCase()}-secret`);
    assert.equal(result.url, profile === 'DEMO' ? 'https://github.com/team/demo.git' : 'https://sandbox.example.com/team/frontend.git');
  }
  assert.throws(() => resolveTarget(githubPublishEnv({ target_profile: 'UNKNOWN' })), /profile has no target URL/);
  assert.throws(() => resolveTarget(githubPublishEnv({ target_profile: 'DEMO' }, {
    secrets: { DEMO_TARGET_REPO_CREDENTIALS: '' },
  })), /Missing publish token.*DEMO_TARGET_REPO_CREDENTIALS/);
  assert.throws(() => resolveTarget(githubPublishEnv({ target_profile: 'DEMO' }, {
    vars: { DEMO_TARGET_REPO_URL: '' },
  })), /profile has no target URL/);
  assert.throws(() => resolveTarget(githubPublishEnv({}, {
    secrets: { DEFAULT_TARGET_REPO_CREDENTIALS: '' },
  })), /Missing publish token.*DEFAULT_TARGET_REPO_CREDENTIALS/);
  assert.deepEqual(resolveTarget(githubPublishEnv({})), defaultTarget);
});

test('CI configuration exposes only saved target selection and no plain-text credential inputs', () => {
  const inputNames = [...github.matchAll(/^      ([a-z_]+):$/gm)].map((match) => match[1]);
  assert.deepEqual(inputNames, ['operation', 'target_profile', 'ids_styles_ref']);
  const variables = gitlab.match(/^variables:\n([\s\S]*?)(?=^\S)/m)?.[1];
  assert.ok(variables);
  assert.deepEqual([...variables.matchAll(/^  ([A-Z_]+):$/gm)].map((match) => match[1]),
    ['IDS_STYLES_REF', 'PUBLISH_TARGET_PROFILE']);
  for (const config of [github, gitlab]) {
    assert.doesNotMatch(config, /custom_target_repo|CUSTOM_TARGET_REPO|Mask custom publish token/);
  }
});
