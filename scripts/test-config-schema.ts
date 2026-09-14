/**
 * Regression tests for the JSON Schemas exposed by the config CLI and API.
 * Run: pnpm test:config-schema
 */

import { configJsonSchema, secretsJsonSchema } from '../src/lib/config/schema';

let passed = 0;
let failed = 0;

function ok(name: string, condition: boolean): void {
  if (condition) {
    passed++;
    console.log(`  ✓ ${name}`);
  } else {
    failed++;
    console.error(`  ✗ ${name}`);
  }
}

function definition(schema: typeof configJsonSchema, name: string): Record<string, unknown> {
  return schema.definitions[name] as Record<string, unknown>;
}

console.log('=== Config JSON Schema ===\n');

const configDefinition = definition(configJsonSchema, 'OpenTalonConfig');
const configProperties = configDefinition.properties as Record<string, unknown> | undefined;
ok('config schema keeps its named definition', configJsonSchema.$ref === '#/definitions/OpenTalonConfig');
ok('config definition is an object', configDefinition.type === 'object');
ok('config definition contains top-level properties', Boolean(configProperties && Object.keys(configProperties).length > 0));
ok('config definition contains tools', Boolean(configProperties?.tools));
ok('strict config rejects additional properties', configDefinition.additionalProperties === false);

const secretsDefinition = definition(secretsJsonSchema, 'OpenTalonSecrets');
const secretsProperties = secretsDefinition.properties as Record<string, unknown> | undefined;
ok('secrets schema keeps its named definition', secretsJsonSchema.$ref === '#/definitions/OpenTalonSecrets');
ok('secrets definition contains top-level properties', Boolean(secretsProperties && Object.keys(secretsProperties).length > 0));
ok('secrets definition contains custom secrets', Boolean(secretsProperties?.custom));

console.log(`\n${failed === 0 ? '[OK]' : '[FAIL]'} ${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
