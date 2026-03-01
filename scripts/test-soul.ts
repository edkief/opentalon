import { soulManager } from '../src/lib/soul';

console.log('=== OpenPincer Soul & Identity Test ===\n');

const soulData = soulManager.load();

console.log('--- Soul Configuration ---');
console.log(JSON.stringify(soulData.config, null, 2));

console.log('\n--- Soul Content ---');
console.log(soulData.content);

console.log('\n--- Identity Content ---');
console.log(soulManager.getIdentityContent());

console.log('\n--- Identity Config ---');
console.log(JSON.stringify(soulManager.getIdentityConfig(), null, 2));

console.log('\n--- Test Complete ---');
