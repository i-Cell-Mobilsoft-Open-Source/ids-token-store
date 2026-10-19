// These tests exercise routing expressions from the checked-in configuration.
// They do not simulate a hosted Actions runner or a GitLab scheduler.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
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
  assert.match(ghJob('publish_tokens'), /TARGET_REPO_CREDENTIALS: \$\{\{ secrets.TARGET_REPO_CREDENTIALS \}\}/);
  assert.match(ghJob('publish_tokens'), /PUBLISH_TARGET_REPO_URL: \$\{\{ inputs.target_repo_url \}\}/);
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
  assert.match(gitlab, /PUBLISH_TARGET_REPO_URL:\n\s+value: ""/);
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
