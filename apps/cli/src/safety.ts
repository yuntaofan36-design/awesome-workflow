export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode = 1,
  ) {
    super(message);
    this.name = 'CliError';
  }
}

export class SecretRedactor {
  readonly #secrets = new Set<string>();

  add(secret: string | undefined): void {
    if (secret && secret.length >= 4) this.#secrets.add(secret);
  }

  clean(value: unknown): string {
    let message = value instanceof Error ? value.message : String(value);
    for (const secret of this.#secrets) message = message.replaceAll(secret, '[redacted]');
    return message
      .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [redacted]')
      .replace(/([?&](?:token|code|signature|x-amz-signature)=)[^&\s]+/gi, '$1[redacted]')
      .slice(0, 2_000);
  }
}

export type TextWriter = (text: string) => void;

export function writeLine(writer: TextWriter, value: string): void {
  writer(`${value}\n`);
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function requireEnvironmentSecret(
  name: string,
  environment: NodeJS.ProcessEnv,
  redactor?: SecretRedactor,
): string {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) {
    throw new CliError('Environment variable names must contain only letters, digits, and underscores.');
  }
  const value = environment[name];
  if (!value) throw new CliError(`Environment variable ${name} is empty or missing.`);
  redactor?.add(value);
  return value;
}
