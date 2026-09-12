import { readFileSync } from 'node:fs';
import { stderr, stdin, stdout } from 'node:process';
import { parse as parseDotEnv } from 'dotenv';
import { buildSemanticCaptureEnvelope } from './capture-envelope.js';
import { SemanticRequestSchema, type SemanticTrackResult } from './contract-v2.js';

console.log = (...args: unknown[]) => {
  stderr.write(`${args.map((value) => String(value)).join(' ')}\n`);
};

async function readStdin(): Promise<string> {
  let raw = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) raw += chunk;
  return raw;
}

let observed: SemanticTrackResult | null = null;
try {
  const semanticEnvFile = process.env.SUBWAVE_ENV_FILE?.trim();
  if (semanticEnvFile && !process.env.OPENROUTER_API_KEY) {
    const parsed = parseDotEnv(readFileSync(semanticEnvFile));
    const key = parsed.OPENROUTER_API_KEY?.trim();
    if (key) process.env.OPENROUTER_API_KEY = key;
  }
  const semanticStateRoot = process.env.SUBWAVE_STATE_DIR?.trim();
  if (semanticStateRoot) process.env.STATE_DIR = semanticStateRoot;
  const { classifySemantic } = await import('./classify.js');
  const request = SemanticRequestSchema.parse(JSON.parse(await readStdin()));
  const mock = process.env.SUBWAVE_SEMANTIC_MOCK === '1';
  const response = await classifySemantic(request, mock, { onRawResult: (result) => { observed = result; } });
  stdout.write(`${JSON.stringify(buildSemanticCaptureEnvelope(response, observed, null))}\n`);
} catch (error) {
  const message = error instanceof Error ? error.message : 'semantic classification failed';
  stdout.write(`${JSON.stringify(buildSemanticCaptureEnvelope(null, observed, message))}\n`);
  stderr.write(`${message}\n`);
  process.exitCode = 1;
}
