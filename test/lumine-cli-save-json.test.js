import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { save, versionsCommand, parseArgs } from '../lib/commands.js';

function fixture(t, { publishFailure = false, canPublish = true } = {}) {
  const root = path.resolve('work/save-json-tests'); fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'case-'));
  const authFile = path.join(dir, 'auth.json');
  const workspace = path.join(dir, 'workspace');
  const build = { id: 2, title: 'Fixture', role: 'owner', canWrite: true, canPublish };
  fs.mkdirSync(path.join(workspace, '.twinkle'), { recursive: true });
  fs.writeFileSync(path.join(workspace, 'index.html'), '<p>hello</p>');
  fs.writeFileSync(path.join(workspace, '.twinkle/lumine-project.json'), JSON.stringify({ schemaVersion: 1, buildId: 2, build, filesHash: 'a'.repeat(64), apiUrl: 'https://api.example.test' }));
  fs.writeFileSync(authFile, JSON.stringify({ token: 'fixture-token', apiUrl: 'https://api.example.test' }));
  const output = [], requests = [];
  t.mock.method(console, 'log', line => output.push(String(line)));
  t.mock.method(globalThis, 'fetch', async (url, init) => {
    const endpoint = new URL(url).pathname; requests.push({ endpoint, body: init?.body });
    let body, status = 200;
    if (endpoint === '/cli/session') body = { userId: 5, scopes: ['build:read', 'build:write'] };
    else if (endpoint === '/cli/build/2/files') body = { build };
    else if (endpoint === '/build/2/project-files') body = { ok: true, success: true, build, artifactVersion: { versionNumber: 12, versionId: 123 }, filesHash: 'b'.repeat(64), projectManifest: { entryPath: '/index.html' } };
    else if (endpoint === '/build/2/publish') {
      status = publishFailure ? 409 : 200;
      body = publishFailure ? { error: 'Review required' } : { build: { ...build, releaseStatus: { state: 'up_to_date' }, publishedArtifactVersionId: 123 } };
    } else if (endpoint === '/cli/build/2/versions') body = { build, versions: [{ version: 12, id: 123 }] };
    else throw new Error('Unexpected fixture request: ' + endpoint);
    return { ok: status === 200, status, text: async () => JSON.stringify(body) };
  });
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { output, requests, workspace, options: (command, extra = []) => parseArgs([command, '--dir', workspace, '--auth-file', authFile, '--api-url', 'https://api.example.test', '--no-update-check', '--json', ...extra]) };
}

test('save --json emits one parseable canonical receipt and preserves the new workspace base', async t => {
  const f = fixture(t);
  await save(f.options('save'));
  assert.equal(f.output.length, 1);
  const result = JSON.parse(f.output[0]);
  assert.equal(result.ok, true); assert.equal(result.artifactVersion.versionId, 123);
  assert.equal(result.filesHash, 'b'.repeat(64)); assert.equal(result.publication, null);
  assert.equal(JSON.parse(fs.readFileSync(path.join(f.workspace, '.twinkle/lumine-project.json'))).filesHash, result.filesHash);
  const sent = JSON.parse(f.requests.find(r => r.endpoint === '/build/2/project-files').body);
  assert.equal(sent.baseFilesHash, 'a'.repeat(64));
});

test('save --json --publish reports canonical publication in the same receipt', async t => {
  const f = fixture(t);
  await save(f.options('save', ['--publish']));
  assert.equal(f.output.length, 1);
  const result = JSON.parse(f.output[0]);
  assert.equal(result.publication.published, true);
  assert.equal(result.build.publishedArtifactVersionId, 123);
});

test('publication refusal retains the successful save receipt but still fails the command', async t => {
  const f = fixture(t, { publishFailure: true });
  await assert.rejects(save(f.options('save', ['--publish'])), /Review required/);
  assert.equal(f.output.length, 1);
  const result = JSON.parse(f.output[0]);
  assert.equal(result.ok, false); assert.equal(result.artifactVersion.versionId, 123);
  assert.equal(result.publication.published, false);
});

test('a contribution save cannot claim publication or send the publish request', async t => {
  const f = fixture(t, { canPublish: false });
  await save(f.options('save', ['--publish']));
  const result = JSON.parse(f.output[0]);
  assert.equal(result.publication.published, false);
  assert.equal(f.requests.some(r => r.endpoint.endsWith('/publish')), false);
});

test('versions --json returns the canonical history with no prose', async t => {
  const f = fixture(t);
  await versionsCommand(f.options('versions'));
  assert.equal(f.output.length, 1);
  assert.deepEqual(JSON.parse(f.output[0]).versions, [{ version: 12, id: 123 }]);
});
