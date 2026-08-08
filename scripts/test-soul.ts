import { agentRegistry } from '../src/lib/soul';

console.log('=== OpenTalon Agent Definition Test ===\n');

const sm = agentRegistry.getSoulManager(agentRegistry.getDefaultAgent());

console.log('--- Agent Configuration ---');
console.log(JSON.stringify(sm.getConfig(), null, 2));

console.log('\n--- Agent Content ---');
console.log(sm.getContent());

console.log('\n--- Test Complete ---');
