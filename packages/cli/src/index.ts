import { run } from './cli';

// `annotate issues | head` closes stdout early; that's not an error.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') process.exit(0);
  throw err;
});

run(process.argv.slice(2)).then(
  (code) => {
    process.exitCode = code;
  },
  (err: unknown) => {
    process.stderr.write(`error: ${(err as Error)?.stack ?? String(err)}\n`);
    process.exitCode = 1;
  },
);
