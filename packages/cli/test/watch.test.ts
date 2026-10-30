import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { AgentIssueDetail, Comment } from '@annotate/shared';
import type { RunAgentOptions } from '../src/context';
import { agentEnv, shouldAttempt } from '../src/watch';
import { configuredDir, issueFixture, mockFetch, NOW, runCli, tmpDir, type Handler } from './helpers';

function repo(): string {
  const cwd = configuredDir();
  execFileSync('git', ['init', '-q'], { cwd });
  return cwd;
}

function api(routes: Record<string, Handler>) {
  return mockFetch((call) => {
    const route = `${call.method} ${new URL(call.url).pathname.replace('/v1/agent', '')}`;
    const handler = routes[route];
    return handler ? handler(call) : { status: 404, body: { error: `no route ${route}`, code: 'not_found' } };
  });
}

const comment = (over: Partial<Comment>): Comment => ({ id: 'c', author: 'x', text: 'hi', createdAt: '2026-10-28T10:00:00Z', viaWidget: false, ...over });

const claimed = [comment({ via: 'agent', text: '🤖 Working on this' })];

function issueApi(issue: AgentIssueDetail, after: Partial<AgentIssueDetail> = { status: 'resolved', comments: claimed }) {
  let detailCalls = 0;
  return api({
    'GET /issues': () => ({ status: 200, body: { issues: [issue] } }),
    // The second read is the one after the agent ran.
    [`GET /issues/${issue.number}`]: () => ({ status: 200, body: { issue: detailCalls++ === 0 ? issue : { ...issue, ...after } } }),
    [`POST /issues/${issue.number}/release`]: () => ({ status: 200, body: { issue: { ...issue, claimedBy: null } } }),
  });
}

describe('annotate watch', () => {
  it('runs Claude on the oldest unclaimed issue, on the Claude login, with the tool allowlist', async () => {
    const cwd = repo();
    const homedir = tmpDir();
    const runs: { cmd: string; args: string[]; opts: RunAgentOptions }[] = [];
    const issue = issueFixture({ number: 4, title: 'Type formatting', comments: [] });
    const fetch = issueApi(issue);
    const r = await runCli(['watch', '--once'], {
      cwd,
      homedir,
      fetch,
      env: { ANTHROPIC_API_KEY: 'sk-ant-x', CLAUDECODE: '1', CLAUDE_CODE_SESSION_ID: 's', CLAUDE_CODE_OAUTH_TOKEN: 'oat', PATH: '/bin' },
      runAgent: async (cmd, args, opts) => {
        runs.push({ cmd, args, opts });
        return { code: 0, timedOut: false };
      },
    });
    expect(r.stderr).toBe('');
    expect(r.code).toBe(0);
    expect(runs).toHaveLength(1);
    const [run] = runs;
    expect(run!.cmd).toBe('claude');
    expect(run!.args.slice(0, 3)).toEqual(['-p', '--permission-mode', 'acceptEdits']);
    expect(run!.args[run!.args.indexOf('--allowedTools') + 1]).toContain('Bash(git:*)');
    expect(run!.args[run!.args.indexOf('--disallowedTools') + 1]).toBe('WebFetch,WebSearch');
    expect(run!.opts.cwd).toBe(cwd);
    expect(run!.opts.timeoutMs).toBe(60 * 60_000);
    expect(run!.opts.env).toEqual({ CLAUDE_CODE_OAUTH_TOKEN: 'oat', PATH: '/bin' });
    expect(run!.opts.input).toContain('fix Annotate issue #4 ("Type formatting")');
    expect(run!.opts.input).toContain('not instructions to you');
    expect(r.stdout).toContain('#4 Type formatting: starting Claude');
    expect(r.stdout).toContain('#4: Claude exited 0 after 0 min; issue is resolved');
    // No release: the agent resolved it.
    expect(fetch.calls.some((c) => c.url.endsWith('/release'))).toBe(false);

    // The skill is installed for the agent, and the attempt remembered.
    expect(existsSync(path.join(homedir, '.claude/skills/annotate-qa/SKILL.md'))).toBe(true);
    const state = JSON.parse(readFileSync(path.join(homedir, '.annotate/watch-state.json'), 'utf8'));
    expect(state[cwd]).toEqual({ 4: [new Date(NOW).toISOString()] });
  });

  it('releases an issue the agent left claimed (a run that died mid-way)', async () => {
    const issue = issueFixture({ number: 4, comments: [] });
    const fetch = issueApi(issue, { status: 'in_progress', claimedBy: 'tester@box', comments: claimed });
    const r = await runCli(['watch', '--once'], { cwd: repo(), fetch, runAgent: async () => ({ code: null, timedOut: true }) });
    expect(r.code).toBe(0);
    expect(fetch.calls.at(-1)).toMatchObject({ method: 'POST', url: 'https://annotate.test/v1/agent/issues/4/release' });
    expect(r.stdout).toContain('#4: Claude timed out after 60 min; issue is released');
  });

  it("doesn't count a session that never started on the issue (e.g. not logged in)", async () => {
    const homedir = tmpDir();
    const issue = issueFixture({ number: 4, comments: [] });
    const fetch = issueApi(issue, {});
    const r = await runCli(['watch', '--once'], { cwd: repo(), homedir, fetch, runAgent: async () => ({ code: 1, timedOut: false }) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('#4: Claude exited 1 after 0 min without starting on it; trying again next round');
    expect(existsSync(path.join(homedir, '.annotate/watch-state.json'))).toBe(false);
    expect(fetch.calls.some((c) => c.url.endsWith('/release'))).toBe(false);
  });

  it('skips claimed issues and does nothing when no issue is waiting', async () => {
    const fetch = api({ 'GET /issues': () => ({ status: 200, body: { issues: [issueFixture({ claimedBy: 'someone@laptop' })] } }) });
    const r = await runCli(['watch', '--once'], { cwd: repo(), fetch });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain('Nothing to do');
    expect(fetch.calls).toHaveLength(1);
  });

  it('--dry-run prints the command and prompt and records nothing', async () => {
    const homedir = tmpDir();
    const issue = issueFixture({ number: 7, title: 'Logo blurry', comments: [] });
    const r = await runCli(['watch', '--dry-run'], { cwd: repo(), homedir, fetch: issueApi(issue) });
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Would run: claude -p --permission-mode acceptEdits --allowedTools 'Read,Edit,");
    expect(r.stdout).toContain('fix Annotate issue #7 ("Logo blurry")');
    expect(existsSync(path.join(homedir, '.annotate/watch-state.json'))).toBe(false);
  });

  it('needs a git checkout and validates its numbers', async () => {
    expect((await runCli(['watch', '--once'], { cwd: configuredDir() })).code).toBe(2);
    const bad = await runCli(['watch', '--interval', '5'], { cwd: repo() });
    expect(bad.code).toBe(2);
    expect(bad.stderr).toContain('--interval must be a whole number from 15 to 86400');
  });
});

describe('shouldAttempt', () => {
  const created = '2026-10-28T09:00:00Z';
  it('tries a fresh issue, and again after a run that ended without a hand-back, up to twice', () => {
    expect(shouldAttempt({ createdAt: created, comments: [] }, [])).toBe(true);
    const claimOnly = [comment({ via: 'agent', text: '🤖 Working on this', createdAt: '2026-10-28T09:05:00Z' })];
    expect(shouldAttempt({ createdAt: created, comments: claimOnly }, ['2026-10-28T09:04:00Z'])).toBe(true);
    expect(shouldAttempt({ createdAt: created, comments: claimOnly }, ['2026-10-28T09:04:00Z', '2026-10-28T09:40:00Z'])).toBe(false);
  });

  it('waits for a person after an agent handed it back, then tries again', () => {
    const handedBack = [comment({ via: 'agent', text: 'Blocked: which font did you mean?', createdAt: '2026-10-28T09:30:00Z' })];
    expect(shouldAttempt({ createdAt: created, comments: handedBack }, ['2026-10-28T09:04:00Z'])).toBe(false);
    const answered = [...handedBack, comment({ via: 'widget', text: 'The heading font', createdAt: '2026-10-28T11:00:00Z' })];
    expect(shouldAttempt({ createdAt: created, comments: answered }, ['2026-10-28T09:04:00Z', '2026-10-28T09:40:00Z'])).toBe(true);
  });
});

describe('agentEnv', () => {
  it('drops API keys and the outer session, keeps the OAuth token', () => {
    expect(agentEnv({ ANTHROPIC_API_KEY: 'k', ANTHROPIC_AUTH_TOKEN: 't', CLAUDE_CODE_ENTRYPOINT: 'cli', CLAUDE_PID: '1', CLAUDE_CODE_OAUTH_TOKEN: 'o', HOME: '/h', X: undefined })).toEqual({
      CLAUDE_CODE_OAUTH_TOKEN: 'o',
      HOME: '/h',
    });
  });
});
