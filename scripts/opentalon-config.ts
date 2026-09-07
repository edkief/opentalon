#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { ConfigSchema, configJsonSchema } from '../src/lib/config/schema';

const workspace = process.env.AGENT_WORKSPACE ?? '/workspace';
const configPath = path.join(workspace, 'config.yaml');
const snapshotsDir = path.join(workspace, 'config-snapshots');

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function validateFile(filePath: string): string {
  let content: string;
  try {
    content = fs.readFileSync(filePath, 'utf8');
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }

  let value: unknown;
  try {
    value = parseYaml(content) ?? {};
  } catch (error) {
    fail(`YAML syntax: ${error instanceof Error ? error.message : String(error)}`);
  }

  const result = ConfigSchema.safeParse(value);
  if (!result.success) {
    fail(result.error.issues.map((issue) => `${issue.path.join('.') || '<root>'}: ${issue.message}`).join('\n'));
  }
  return content;
}

function createSnapshot(): string {
  fs.mkdirSync(snapshotsDir, { recursive: true });
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filename = `config-${timestamp}.yaml`;
  fs.writeFileSync(
    path.join(snapshotsDir, filename),
    fs.existsSync(configPath) ? fs.readFileSync(configPath, 'utf8') : '',
    { mode: 0o600 },
  );
  return filename;
}

const [command, argument] = process.argv.slice(2);

switch (command) {
  case 'show':
    if (!fs.existsSync(configPath)) fail(`${configPath} does not exist`);
    process.stdout.write(fs.readFileSync(configPath, 'utf8'));
    break;
  case 'schema':
    process.stdout.write(`${JSON.stringify(configJsonSchema, null, 2)}\n`);
    break;
  case 'validate': {
    const candidate = path.resolve(argument ?? configPath);
    validateFile(candidate);
    console.log(`Valid OpenTalon config: ${candidate}`);
    break;
  }
  case 'snapshot':
    console.log(`Created ${createSnapshot()}`);
    break;
  case 'apply': {
    if (!argument) fail('apply requires a candidate YAML path');
    const candidate = path.resolve(argument);
    const content = validateFile(candidate);
    const snapshot = createSnapshot();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, content, 'utf8');
    console.log(`Applied ${candidate} to ${configPath}; rollback snapshot: ${snapshot}`);
    break;
  }
  default:
    console.log(`Usage: opentalon-config <command>

Commands:
  show                 Print the current config.yaml
  schema               Print the authoritative JSON Schema
  validate [file]      Validate a candidate (defaults to config.yaml)
  snapshot             Snapshot the current config without changing it
  apply <file>          Validate, snapshot, then apply a candidate`);
    if (command) process.exitCode = 1;
}
