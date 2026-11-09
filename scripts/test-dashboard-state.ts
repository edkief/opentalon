/**
 * Pure dashboard state helpers from epic #80:
 *   - #88: model dropdown options always include the agent's own model.
 *
 * Run with: pnpm test:dashboard-state
 */
import { modelOptions } from '../src/app/dashboard/agents/model-options';

let failed = 0;
function ok(label: string, condition: boolean): void {
  if (condition) {
    console.log(`  ✓ ${label}`);
    return;
  }
  failed += 1;
  console.log(`  ✗ ${label}`);
}

console.log('#88 model dropdown options');
{
  const available = ['anthropic/claude-sonnet-4-6', 'openai/gpt-4o'];

  const listed = modelOptions(available, 'openai/gpt-4o');
  ok('a listed model adds nothing', listed.length === 2 && listed.every((o) => o.label === o.value));

  ok('inherit (empty) adds nothing', modelOptions(available, '').length === 2);

  const own = modelOptions(available, 'minimax/MiniMax-M3');
  ok('an unlisted model is added first', own[0]?.value === 'minimax/MiniMax-M3');
  ok('and marked as not in the list', own[0]?.label === 'minimax/MiniMax-M3 (not in list)');
  ok('the listed models follow', own.length === 3 && own[1].value === available[0]);

  const none = modelOptions([], 'minimax/MiniMax-M3');
  ok('shown even when no models are detected', none.length === 1 && none[0].value === 'minimax/MiniMax-M3');
}

if (failed) {
  console.log(`\n${failed} check(s) failed`);
  process.exit(1);
}
console.log('\nAll checks passed');
