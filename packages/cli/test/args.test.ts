import { describe, expect, it } from 'vitest';
import { splitCommand } from '../src/cli';
import { configuredDir, runCli } from './helpers';

describe('splitCommand', () => {
  it('finds the command after global options and their values', () => {
    expect(splitCommand(['issues', '--json'])).toEqual({ command: 'issues', rest: ['--json'] });
    expect(splitCommand(['--json', 'show', '12'])).toEqual({ command: 'show', rest: ['--json', '12'] });
    expect(splitCommand(['--endpoint', 'http://x', 'issues'])).toEqual({ command: 'issues', rest: ['--endpoint', 'http://x'] });
    expect(splitCommand(['--endpoint=http://x', 'issues'])).toEqual({ command: 'issues', rest: ['--endpoint=http://x'] });
    expect(splitCommand(['--help'])).toEqual({ command: null, rest: ['--help'] });
  });
});

describe('help', () => {
  it('prints global help with no arguments, --help, or help', async () => {
    for (const argv of [[], ['--help'], ['-h'], ['help']]) {
      const r = await runCli(argv);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain('Usage: annotate <command>');
      expect(r.stdout).toContain('Exit codes:');
    }
  });

  it('prints command help without needing config or required args', async () => {
    for (const argv of [['issues', '--help'], ['help', 'issues'], ['show', '--help'], ['resolve', '-h'], ['whoami', '--help']]) {
      const r = await runCli(argv);
      expect(r.code, argv.join(' ')).toBe(0);
      expect(r.stdout).toMatch(/^Usage: annotate /);
      expect(r.stderr).toBe('');
    }
  });

  it('prints the version', async () => {
    const r = await runCli(['--version']);
    expect(r.code).toBe(0);
    expect(r.stdout.trim()).toMatch(/^(dev|\d+\.\d+\.\d+)$/);
  });
});

describe('usage errors exit 2', () => {
  const cases: Array<[string[], RegExp]> = [
    [['frobnicate'], /unknown command 'frobnicate'/],
    [['help', 'frobnicate'], /unknown command 'frobnicate'/],
    [['issues', '--bogus'], /unknown option '--bogus'/],
    [['issues', '--status'], /argument missing/],
    [['issues', '--status', 'done'], /--status must be one of open, new, in_progress, review, resolved, archived, all/],
    [['issues', 'extra'], /unexpected argument 'extra'/],
    [['show'], /missing issue number/],
    [['show', 'abc'], /'abc' is not an issue number/],
    [['show', '12', '13'], /unexpected argument '13'/],
    [['claim', '12', '--minutes', '999'], /--minutes must be a whole number from 1 to 240/],
    [['claim', '12', '--minutes', '1.5'], /--minutes must be/],
    [['comment', '12'], /missing comment text/],
    [['resolve', '12'], /--note "<text>" is required/],
    [['resolve', '12', '--note', '  '], /--note "<text>" is required/],
    [['reopen', '12'], /--note "<text>" is required/],
    [['origins', 'frob'], /unknown subcommand 'frob'/],
    [['origins', 'add'], /missing origin/],
    [['origins', 'add', 'ftp://x.com'], /not a valid origin/],
    [['skill'], /expected install or print/],
    [['connect', '--site', 'not a url'], /--site 'not a url' is not a URL/],
    [['--endpoint', 'nope', 'issues'], /invalid endpoint 'nope'/],
  ];

  it.each(cases)('%j', async (argv, message) => {
    const r = await runCli(argv, { cwd: configuredDir() });
    expect(r.code).toBe(2);
    expect(r.stdout).toBe('');
    expect(r.stderr).toMatch(/^error: /);
    expect(r.stderr).toMatch(message);
  });

  it('points to the command help', async () => {
    const r = await runCli(['show']);
    expect(r.stderr).toBe("error: missing issue number\nRun 'annotate show --help' for usage.\n");
  });

  it('accepts #12 and text after --', async () => {
    const cwd = configuredDir();
    const { mockFetch } = await import('./helpers');
    const fetch = mockFetch((c) => ({ status: 201, body: { issue: { number: 12 }, echo: c.body } }));
    const r = await runCli(['comment', '#12', '--', '-1px', 'off', '--json'], { cwd, fetch });
    expect(r.code).toBe(0);
    expect(fetch.calls[0]?.url).toBe('https://annotate.test/v1/agent/issues/12/comments');
    expect(fetch.calls[0]?.body).toEqual({ text: '-1px off --json', author: 'tester@box' });
  });
});
