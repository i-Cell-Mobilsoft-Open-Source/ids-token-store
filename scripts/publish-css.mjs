#!/usr/bin/env node

import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const scriptPath = fileURLToPath(import.meta.url);
class PublishError extends Error {}
const fail = (message) => { throw new PublishError(message); };
const inCi = (env) => [env.CI, env.GITHUB_ACTIONS, env.GITLAB_CI].some(
  (value) => value && value !== 'false',
);

// Normalize clone URLs without embedding credentials in Git arguments/config.
function repository(raw, { legacy = false, local = false } = {}) {
  if (local && (path.isAbsolute(raw) || raw.startsWith('file:///'))) {
    const localPath = raw.startsWith('file:') ? fileURLToPath(raw) : raw;
    return { url: pathToFileURL(path.resolve(localPath)).href };
  }
  // Keep existing SSH defaults usable with a preconfigured deploy key/agent.
  // Manual destination selection uses credential-free HTTPS only.
  if (legacy && /^git@[A-Za-z0-9.-]+:/.test(raw)) raw = raw.replace(/^git@([^:]+):/, 'ssh://git@$1/');
  let url;
  try { url = new URL(raw); } catch { fail('Invalid target repository URL. Use an HTTPS clone URL.'); }
  const ssh = legacy && url.protocol === 'ssh:' && url.username === 'git' && !url.password;
  if ((!ssh && (url.protocol !== 'https:' || !raw.startsWith('https://'))) || /[\s\\?#]/.test(raw) || /%/.test(url.pathname) ||
      !/^\/[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+\/?$/.test(url.pathname) ||
      /\/(?:\.{1,2})(?:\/|$)/.test(raw)) {
    fail('Invalid target repository URL. Use HTTPS with an exact repository path, without query or fragment.');
  }
  if (!legacy && (url.username || url.password)) {
    fail('Target repository URLs must not contain a username, token or password. Configure publish secrets instead.');
  }
  const username = ssh ? '' : decodeURIComponent(url.username);
  const token = ssh ? '' : decodeURIComponent(url.password);
  if (!ssh) url.username = '';
  url.password = '';
  url.pathname = url.pathname.replace(/\/$/, '');
  return { url: url.href, username, token };
}

export function resolveTarget(env) {
  const local = !inCi(env);
  const defaultTarget = env.TARGET_REPO_URL?.trim()
    ? repository(env.TARGET_REPO_URL.trim(), { legacy: true, local }) : undefined;
  const override = env.PUBLISH_TARGET_REPO_URL?.trim();
  const target = override ? repository(override, { local }) : defaultTarget;
  if (!target) fail('TARGET_REPO_URL must be configured, or supply PUBLISH_TARGET_REPO_URL.');
  // Existing URL credentials remain usable for the configured default only.
  // An override can never redirect those credentials to another repository.
  const legacy = target.url === defaultTarget?.url ? defaultTarget : {};
  const sameServer = defaultTarget && new URL(target.url).origin === new URL(defaultTarget.url).origin;
  let username = sameServer ? env.TARGET_REPO_USERNAME || legacy.username || '' : '';
  let token = sameServer ? env.TARGET_REPO_TOKEN || legacy.token || '' : '';
  if (env.TARGET_REPO_CREDENTIALS?.trim()) {
    // Keep the credential and its issuer together in one secret. Changing a
    // manual destination can never rebind an existing secret to another server.
    let credentials;
    let issuer;
    try {
      credentials = JSON.parse(env.TARGET_REPO_CREDENTIALS);
      issuer = new URL(credentials.origin);
    } catch {
      fail('TARGET_REPO_CREDENTIALS must be a JSON secret with origin, username and token.');
    }
    if (issuer.protocol !== 'https:' || issuer.username || issuer.password ||
        issuer.pathname !== '/' || issuer.search || issuer.hash ||
        typeof credentials.username !== 'string' || !credentials.username ||
        typeof credentials.token !== 'string' || !credentials.token) {
      fail('TARGET_REPO_CREDENTIALS requires an HTTPS origin without a path or credentials, plus a nonempty username and token.');
    }
    if (new URL(target.url).origin === issuer.origin) {
      ({ username, token } = credentials);
    } else if (!sameServer) {
      fail('No matching credentials for the selected server. Configure TARGET_REPO_CREDENTIALS with that server origin and its own token; no default credentials were forwarded.');
    }
  }
  if (Boolean(username) !== Boolean(token) || /[\r\n\0]/.test(username + token)) {
    fail('Publish credentials require both a username and token, without line breaks or NUL bytes. Check TARGET_REPO_CREDENTIALS or TARGET_REPO_USERNAME/TARGET_REPO_TOKEN.');
  }
  if (target.url.startsWith('file:') && (username || token)) {
    fail('Local test repositories must not receive publish credentials.');
  }
  if (target.url.startsWith('ssh:') && (username || token)) {
    fail('An SSH default uses a deploy key/agent, not TARGET_REPO_USERNAME or TARGET_REPO_TOKEN.');
  }
  if (inCi(env) && !token && !target.url.startsWith('ssh:')) {
    fail('Missing publish credentials for the selected server. Use TARGET_REPO_USERNAME and TARGET_REPO_TOKEN on the default server, or TARGET_REPO_CREDENTIALS with the selected HTTPS origin, username and token.');
  }
  return { url: target.url, username, token };
}

// Git credential protocol: pipe secrets only to the selected HTTPS host AND path.
export function credentialResponse(input, env) {
  const values = Object.fromEntries(input.trim().split('\n').map((line) => {
    const at = line.indexOf('=');
    return [line.slice(0, at), line.slice(at + 1)];
  }));
  const url = new URL(env.PUBLISH_CREDENTIAL_URL);
  if (values.protocol !== 'https' || values.host !== url.host ||
      values.path !== url.pathname.slice(1) || !env.PUBLISH_CREDENTIAL_TOKEN) return '';
  return `username=${env.PUBLISH_CREDENTIAL_USERNAME}\npassword=${env.PUBLISH_CREDENTIAL_TOKEN}\n\n`;
}

function safePath(root, relative, label) {
  if (path.isAbsolute(relative) || relative.split(/[\\/]/).some((part) => !part || part === '.' || part === '..' || part === '.git')) {
    fail(`${label} must be a safe relative path below the repository root.`);
  }
  const resolved = path.resolve(root, relative);
  let current = root;
  for (const part of relative.split('/')) {
    current = path.join(current, part);
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) {
      fail(`${label} must not traverse symbolic links.`);
    }
  }
  return resolved;
}

function requireRegularFiles(directory) {
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory()) requireRegularFiles(path.join(directory, entry.name));
    else if (!entry.isFile()) fail('Generated CSS must contain only regular files and directories.');
  }
}

export function publish(env = process.env, root = process.cwd()) {
  if (env.SKIP_PARSE !== 'true') {
    const parsed = spawnSync('npm', ['run', 'parse'], { cwd: root, env, stdio: 'inherit' });
    if (parsed.status !== 0) fail('CSS generation failed; publishing was not started.');
  }
  const output = path.resolve(root, env.CSS_OUTPUT_DIR || 'ids_css');
  if (!existsSync(path.join(output, 'tokens.css'))) {
    if (env.SKIP_PARSE === 'true') fail('Generated CSS artifact is missing tokens.css. Re-run CSS generation before publishing.');
    console.log('No generated CSS to publish. Add Figma JSON files under foundations/ or components/.');
    return;
  }
  const target = resolveTarget(env);
  const checkout = safePath(root, env.TARGET_CHECKOUT_DIR || 'target-repo', 'TARGET_CHECKOUT_DIR');
  if (output === checkout || output.startsWith(`${checkout}${path.sep}`) || checkout.startsWith(`${output}${path.sep}`)) {
    fail('TARGET_CHECKOUT_DIR must not overlap the generated CSS directory.');
  }
  requireRegularFiles(output);
  const branch = env.TARGET_REPO_BRANCH || 'IDS_CSS';
  const cssPath = env.TARGET_CSS_PATH || 'projects/demo/src/assets/ids_css';
  safePath(checkout, cssPath, 'TARGET_CSS_PATH');

  const gitEnv = { ...env };
  // Ignore inherited credentials, headers, URL rewrites and tracing.
  // Corporate CA bundles can be supplied through GIT_SSL_CAINFO.
  for (const key of Object.keys(gitEnv)) {
    if (key.startsWith('GIT_') || key.startsWith('PUBLISH_CREDENTIAL_')) delete gitEnv[key];
  }
  Object.assign(gitEnv, {
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0',
    GIT_SSH_COMMAND: 'ssh -o BatchMode=yes -o StrictHostKeyChecking=yes -o ClearAllForwardings=yes -o ForwardAgent=no -o ForwardX11=no',
    GIT_AUTHOR_NAME: env.GIT_AUTHOR_NAME || 'token-pipeline',
    GIT_AUTHOR_EMAIL: env.GIT_AUTHOR_EMAIL || 'token-pipeline@example.invalid',
    GIT_COMMITTER_NAME: env.GIT_AUTHOR_NAME || 'token-pipeline',
    GIT_COMMITTER_EMAIL: env.GIT_AUTHOR_EMAIL || 'token-pipeline@example.invalid',
    PUBLISH_CREDENTIAL_URL: target.url,
    PUBLISH_CREDENTIAL_USERNAME: target.username,
    PUBLISH_CREDENTIAL_TOKEN: target.token,
  });
  if (env.GIT_SSL_CAINFO) gitEnv.GIT_SSL_CAINFO = env.GIT_SSL_CAINFO;
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  const gitOptions = [
    '-c', 'credential.helper=',
    '-c', `credential.helper=!${quote(process.execPath)} ${quote(scriptPath)} --credential`,
    '-c', 'credential.useHttpPath=true', '-c', 'http.extraHeader=',
    '-c', 'http.followRedirects=false', '-c', 'http.sslVerify=true',
    '-c', 'protocol.allow=never', '-c', 'protocol.https.allow=always',
    '-c', `protocol.ssh.allow=${target.url.startsWith('ssh:') ? 'always' : 'never'}`,
    '-c', `protocol.file.allow=${target.url.startsWith('file:') ? 'always' : 'never'}`,
    '-c', 'core.hooksPath=/dev/null', '-c', 'commit.gpgSign=false',
  ];
  const git = (args, cwd = root, { probe = false, message = 'Git operation failed.' } = {}) => {
    const result = spawnSync('git', [...gitOptions, ...args], { cwd, env: gitEnv, encoding: 'utf8' });
    // Server error output may contain credentials or arbitrary remote content.
    if (result.status !== 0 && !probe) fail(message);
    return result;
  };
  git(['check-ref-format', '--branch', branch], root, { message: 'TARGET_REPO_BRANCH is not a valid branch name.' });
  rmSync(checkout, { recursive: true, force: true });
  git(['clone', '--quiet', '--', target.url, checkout], root, {
    message: 'Cannot clone target repository. Check its URL, TLS certificate, token read access and repository availability. Redirects are disabled; use the canonical clone URL.',
  });
  if (git(['show-ref', '--verify', '--quiet', `refs/heads/${branch}`], checkout, { probe: true }).status === 0) {
    git(['switch', branch], checkout);
  } else if (git(['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`], checkout, { probe: true }).status === 0) {
    git(['switch', '--track', `origin/${branch}`], checkout);
  } else {
    git(['switch', '-c', branch], checkout, { message: 'Cannot create target branch. Check the branch name and target repository state.' });
  }
  const destination = safePath(checkout, cssPath, 'TARGET_CSS_PATH');
  rmSync(destination, { recursive: true, force: true });
  mkdirSync(destination, { recursive: true });
  cpSync(output, destination, { recursive: true });
  git(['add', '--', cssPath], checkout);
  const difference = git(['diff', '--cached', '--quiet'], checkout, { probe: true });
  if (difference.status === 0) {
    console.log('Target repository already contains the current CSS.');
    return;
  }
  if (difference.status !== 1) fail('Cannot inspect generated CSS changes.');
  git(['commit', '-m', env.TARGET_COMMIT_MESSAGE || 'chore(tokens): update generated CSS'], checkout, {
    message: 'Cannot commit CSS changes. Check the author name/email and target CSS path.',
  });
  git(['push', 'origin', `HEAD:refs/heads/${branch}`], checkout, {
    message: 'Cannot push CSS. Check token write access, protected branch rules and concurrent changes; regenerate and retry if the branch has moved.',
  });
  console.log(`CSS published successfully to target branch ${branch}.`);
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] === '--credential') {
    if (process.argv[3] === 'get') process.stdout.write(credentialResponse(readFileSync(0, 'utf8'), process.env));
  } else {
    try { publish(); } catch (error) {
      const message = error instanceof PublishError ? error.message : 'Check publish configuration and filesystem permissions.';
      console.error(`Publish failed: ${message}`);
      process.exitCode = 1;
    }
  }
}
