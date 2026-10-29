import { parseArgs } from 'node:util';
import { findCommand, type Command, type Invocation, type OptionSpec } from './commands';
import { makeCtx, VERSION, type Ctx } from './context';
import { CliError, EXIT, UsageError } from './errors';
import { colorEnabled, makeStyle } from './format';
import { COMMAND_HELP, GLOBAL_HELP } from './help';

const GLOBAL_OPTIONS: OptionSpec = {
  json: { type: 'boolean' },
  endpoint: { type: 'string' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

/** The first argument that isn't an option (or a global option's value) is the command. */
export function splitCommand(argv: string[]): { command: string | null; rest: string[] } {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    if (a === '--') break;
    if (a.startsWith('-')) {
      if (a === '--endpoint') i++;
      continue;
    }
    return { command: a, rest: [...argv.slice(0, i), ...argv.slice(i + 1)] };
  }
  return { command: null, rest: argv };
}

function parse(args: string[], options: OptionSpec, command: string | undefined, allowPositionals: boolean) {
  try {
    return parseArgs({ args, options, strict: true, allowPositionals });
  } catch (err) {
    const e = err as { code?: string; message?: string };
    if (!e.code?.startsWith('ERR_PARSE_ARGS')) throw err;
    let msg = (e.message ?? 'invalid arguments').split(/\.\s/)[0] ?? '';
    msg = msg.charAt(0).toLowerCase() + msg.slice(1);
    throw new UsageError(msg, command);
  }
}

function helpFor(name: string): string {
  return COMMAND_HELP[name] ?? GLOBAL_HELP;
}

export async function run(argv: string[], overrides: Partial<Ctx> = {}): Promise<number> {
  const ctx = makeCtx(overrides);
  try {
    return await dispatch(argv, ctx);
  } catch (err) {
    return reportError(err, ctx);
  }
}

async function dispatch(argv: string[], ctx: Ctx): Promise<number> {
  const write = (s: string): void => {
    ctx.stdout.write(s.endsWith('\n') ? s : `${s}\n`);
  };
  const { command: name, rest } = splitCommand(argv);

  if (!name) {
    const { values } = parse(rest, GLOBAL_OPTIONS, undefined, false);
    write(values.version ? VERSION : GLOBAL_HELP);
    return EXIT.ok;
  }

  if (name === 'help') {
    const { positionals } = parse(rest, GLOBAL_OPTIONS, undefined, true);
    const topic = positionals[0];
    const cmd = topic ? findCommand(topic) : undefined;
    if (topic && !cmd) throw new UsageError(`unknown command '${topic}'`);
    write(cmd ? helpFor(cmd.name) : GLOBAL_HELP);
    return EXIT.ok;
  }

  const cmd: Command | undefined = findCommand(name);
  if (!cmd) throw new UsageError(`unknown command '${name}'`);

  const { values, positionals } = parse(rest, { ...GLOBAL_OPTIONS, ...cmd.options }, cmd.name, true);
  if (values.help) {
    write(helpFor(cmd.name));
    return EXIT.ok;
  }
  if (values.version) {
    write(VERSION);
    return EXIT.ok;
  }
  if (positionals.length > cmd.maxPositionals) {
    throw new UsageError(`unexpected argument '${positionals[cmd.maxPositionals]}'`, cmd.name);
  }

  const style = makeStyle(colorEnabled(ctx.stdout, ctx.env));
  const errStyle = makeStyle(colorEnabled(ctx.stderr, ctx.env));
  const inv: Invocation = {
    ctx,
    command: cmd.name,
    values: values as Invocation['values'],
    positionals,
    json: values.json === true,
    endpointFlag: typeof values.endpoint === 'string' ? values.endpoint : undefined,
    style,
    print: (lines) => write(Array.isArray(lines) ? lines.join('\n') : lines),
    printJson: (data) => write(JSON.stringify(data)),
    warn: (message) => {
      ctx.stderr.write(`${errStyle.yellow('warning:')} ${message}\n`);
    },
  };
  const code = await cmd.run(inv);
  return typeof code === 'number' ? code : EXIT.ok;
}

function reportError(err: unknown, ctx: Ctx): number {
  const style = makeStyle(colorEnabled(ctx.stderr, ctx.env));
  const prefix = style.red('error:');
  if (err instanceof CliError) {
    ctx.stderr.write(`${prefix} ${err.message}\n`);
    if (err instanceof UsageError) {
      ctx.stderr.write(err.command ? `Run 'annotate ${err.command} --help' for usage.\n` : "Run 'annotate --help' for usage.\n");
    } else if (err.extra.hint) {
      ctx.stderr.write(`${err.extra.hint}\n`);
    }
    return err.exitCode;
  }
  ctx.stderr.write(`${prefix} ${(err as Error)?.message ?? String(err)}\n`);
  return EXIT.error;
}

