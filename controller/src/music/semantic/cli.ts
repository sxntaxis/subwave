import { readFileSync } from 'node:fs';
import { stderr, stdin, stdout } from 'node:process';
import { parse as parseDotEnv } from 'dotenv';
import { SemanticRequestSchema } from './contract.js';

// stdout is the machine protocol. Existing SubWave retry/provider helpers may
// log transient diagnostics with console.log(), so route those to stderr here.
console.log = (...args: unknown[]) => {
  stderr.write(`${args.map((value) => String(value)).join(' ')}\n`);
};

async function readStdin(): Promise<string> {
  let raw = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) raw += chunk;
  return raw;
}

try {
  // Compose injects controller credentials from SubWave's own .env. The host-
  // side semantic CLI reads ONLY the OpenRouter key from that same file; Coyote
  // receives the path, never the secret value. Existing process env wins.
  const semanticEnvFile = process.env.SUBWAVE_ENV_FILE?.trim();
  if (semanticEnvFile && !process.env.OPENROUTER_API_KEY) {
    let parsed: Record<string, string>;
    try {
      parsed = parseDotEnv(readFileSync(semanticEnvFile));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`SUBWAVE_ENV_FILE_UNAVAILABLE: ${message}`);
    }
    const key = parsed.OPENROUTER_API_KEY?.trim();
    if (key) process.env.OPENROUTER_API_KEY = key;
  }

  // Coyote passes only the host path to SubWave's own state root. Set STATE_DIR
  // before importing classify/settings/provider so SubWave resolves settings.json
  // exactly as its controller does. No credential value is exported to Coyote.
  const semanticStateRoot = process.env.SUBWAVE_STATE_DIR?.trim();
  if (semanticStateRoot) process.env.STATE_DIR = semanticStateRoot;
  const { classifySemantic } = await import('./classify.js');

  const request = SemanticRequestSchema.parse(JSON.parse(await readStdin()));
  const mock = process.env.SUBWAVE_SEMANTIC_MOCK === '1';
  const response = await classifySemantic(request, mock);
  stdout.write(`${JSON.stringify(response)}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'semantic classification failed';
  stderr.write(`${message}\n`);
  process.exitCode = 1;
}
