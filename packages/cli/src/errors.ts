/** Process exit codes. Documented in `annotate --help`; agents branch on them. */
export const EXIT = {
  ok: 0,
  error: 1,
  usage: 2,
  notFound: 3,
  conflict: 4,
  auth: 5,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: number = EXIT.error,
    readonly extra: { status?: number; code?: string; hint?: string } = {},
  ) {
    super(message);
  }
}

export class UsageError extends CliError {
  constructor(message: string, readonly command?: string) {
    super(message, EXIT.usage);
  }
}

export function exitCodeForStatus(status: number): number {
  if (status === 401 || status === 403) return EXIT.auth;
  if (status === 404) return EXIT.notFound;
  if (status === 409) return EXIT.conflict;
  return EXIT.error;
}
