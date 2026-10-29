import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULT_ENDPOINT, ensureGitignored, findConfig, loadSettings, writeConfig } from '../src/config';
import { makeCtx } from '../src/context';
import { mockFetch, runCli, tmpDir, writeTree } from './helpers';

const projectResponse = { name: 'Site', projectKey: 'pk', boardName: 'B', boardUrl: 'u', origins: [], counts: {} };

describe('config discovery', () => {
  it('walks up from the cwd to the nearest .annotate.json', () => {
    const root = tmpDir();
    writeTree(root, { '.annotate.json': { agentToken: 'at_outer' }, 'a/.annotate.json': { agentToken: 'at_inner' } });
    mkdirSync(path.join(root, 'a/b/c'), { recursive: true });
    mkdirSync(path.join(root, 'x'), { recursive: true });
    expect(findConfig(path.join(root, 'a/b/c'))).toMatchObject({ dir: path.join(root, 'a'), config: { agentToken: 'at_inner' } });
    expect(findConfig(path.join(root, 'x'))).toMatchObject({ dir: root, config: { agentToken: 'at_outer' } });
  });

  it('returns null when there is none', () => {
    expect(findConfig(tmpDir())).toBeNull();
  });

  it('reports invalid JSON', () => {
    const root = tmpDir();
    writeTree(root, { '.annotate.json': '{nope' });
    expect(() => findConfig(root)).toThrow(/not valid JSON/);
  });

  it('env overrides the file; --endpoint beats both; trailing slashes go', () => {
    const root = tmpDir();
    writeTree(root, { '.annotate.json': { endpoint: 'https://file.test', agentToken: 'at_file' } });
    const base = { cwd: root, env: {} };
    expect(loadSettings(makeCtx(base))).toMatchObject({ endpoint: 'https://file.test', token: 'at_file', projectDir: root });
    const env = { ANNOTATE_ENDPOINT: 'https://env.test/', ANNOTATE_TOKEN: 'at_env' };
    expect(loadSettings(makeCtx({ ...base, env }))).toMatchObject({ endpoint: 'https://env.test', token: 'at_env' });
    expect(loadSettings(makeCtx({ ...base, env }), 'http://localhost:8787/')).toMatchObject({ endpoint: 'http://localhost:8787' });
    expect(loadSettings(makeCtx({ cwd: tmpDir(), env: {} }))).toMatchObject({ endpoint: DEFAULT_ENDPOINT, token: null });
  });

  it('commands use the discovered endpoint and token', async () => {
    const root = tmpDir();
    writeTree(root, { '.annotate.json': { endpoint: 'https://file.test', agentToken: 'at_file' } });
    mkdirSync(path.join(root, 'sub'));
    const fetch = mockFetch(() => ({ status: 200, body: projectResponse }));
    await runCli(['project', '--json'], { cwd: path.join(root, 'sub'), fetch });
    expect(fetch.calls[0]).toMatchObject({ url: 'https://file.test/v1/agent/project', headers: { authorization: 'Bearer at_file' } });

    await runCli(['project', '--json'], { cwd: path.join(root, 'sub'), fetch, env: { ANNOTATE_TOKEN: 'at_env', ANNOTATE_ENDPOINT: 'https://env.test' } });
    expect(fetch.calls[1]).toMatchObject({ url: 'https://env.test/v1/agent/project', headers: { authorization: 'Bearer at_env' } });
  });

  it('ANNOTATE_TOKEN alone is enough (default endpoint)', async () => {
    const fetch = mockFetch(() => ({ status: 200, body: projectResponse }));
    const r = await runCli(['project', '--json'], { fetch, env: { ANNOTATE_TOKEN: 'at_env' } });
    expect(r.code).toBe(0);
    expect(fetch.calls[0]?.url).toBe(`${DEFAULT_ENDPOINT}/v1/agent/project`);
  });

  it('not configured → exit 3 with a hint to run annotate init', async () => {
    const fetch = mockFetch(() => ({ status: 200, body: {} }));
    const r = await runCli(['issues'], { fetch });
    expect(r.code).toBe(3);
    expect(r.stderr).toMatch(/^error: not configured/);
    expect(r.stderr).toContain('Run `annotate init`');
    expect(fetch.calls).toHaveLength(0);
  });

  it('writeConfig uses mode 0600, even over an existing file', () => {
    const dir = tmpDir();
    writeTree(dir, { '.annotate.json': '{}' });
    const file = writeConfig(dir, { agentToken: 'at_x' });
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ agentToken: 'at_x' });
  });
});

describe('ensureGitignored', () => {
  const gitInit = (dir: string) => execFileSync('git', ['init', '-q'], { cwd: dir });

  it('does nothing outside a git repo', () => {
    expect(ensureGitignored(tmpDir())).toBeNull();
  });

  it('appends missing entries once', () => {
    const dir = tmpDir();
    gitInit(dir);
    writeTree(dir, { '.gitignore': 'node_modules/' });
    expect(ensureGitignored(dir)?.added).toEqual(['.annotate.json', '.annotate/screenshots/']);
    const text = readFileSync(path.join(dir, '.gitignore'), 'utf8');
    expect(text).toBe('node_modules/\n\n# Annotate CLI (agent token, downloaded screenshots)\n.annotate.json\n.annotate/screenshots/\n');
    expect(ensureGitignored(dir)?.added).toEqual([]);
    expect(readFileSync(path.join(dir, '.gitignore'), 'utf8')).toBe(text);
  });

  it('respects existing patterns, and anchors the screenshots dir for a subdirectory', () => {
    const dir = tmpDir();
    gitInit(dir);
    writeTree(dir, { '.gitignore': '.annotate/\n' });
    expect(ensureGitignored(dir)?.added).toEqual(['.annotate.json']);

    const repo = tmpDir();
    gitInit(repo);
    mkdirSync(path.join(repo, 'site'));
    expect(ensureGitignored(path.join(repo, 'site'))?.added).toEqual(['.annotate.json', '/site/.annotate/screenshots/']);
    const check = (p: string) => {
      try {
        execFileSync('git', ['check-ignore', '-q', '--no-index', p], { cwd: repo });
        return true;
      } catch {
        return false;
      }
    };
    expect(check('site/.annotate.json')).toBe(true);
    expect(check('site/.annotate/screenshots/issue-1.png')).toBe(true);
  });
});
