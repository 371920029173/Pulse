import { test } from 'node:test';
import assert from 'node:assert/strict';
import { detectDrift } from '../reflection.js';

const goal = 'verify the server restarted: pid 15884 replaced by 17856';

test('actions matching the current plan step are not drift', () => {
  const r = detectDrift({
    goal,
    currentStep: 'probe netstat port 5577 and lsp_definition on src/types.ts',
    actions: [
      { tool: 'shell', args: '{"command":"netstat -ano | findstr 5577"}' },
      { tool: 'lsp_definition', args: '{"path":"src/types.ts","line":1,"col":15}' },
      { tool: 'shell', args: '{"command":"netstat -ano"}' },
      { tool: 'lsp_definition', args: '{"path":"src/types.ts","line":1,"col":14}' },
      { tool: 'shell', args: '{"command":"netstat -a"}' },
    ],
  });
  assert.equal(r.signals.find((s) => s.kind === 'goal_unrelated'), undefined);
});

test('bookkeeping calls do not count as unrelated work', () => {
  const r = detectDrift({
    goal,
    actions: [
      { tool: 'shell', args: '{"command":"tasklist | findstr 17856"}' },
      { tool: 'plan_update', args: '{"id":"p1"}' },
      { tool: 'reflection_check', args: '{}' },
      { tool: 'errorbook_lookup', args: '{}' },
      { tool: 'memo_list', args: '{}' },
    ],
  });
  assert.equal(r.signals.find((s) => s.kind === 'goal_unrelated'), undefined);
});

test('work unrelated to both goal and step is still reported', () => {
  const r = detectDrift({
    goal,
    currentStep: 'probe netstat port 5577',
    actions: [
      { tool: 'fs_read', args: '{"path":"docs/marketing.md"}' },
      { tool: 'fs_read', args: '{"path":"docs/pricing.md"}' },
      { tool: 'web_fetch', args: '{"url":"https://example.com/blog"}' },
      { tool: 'fs_read', args: '{"path":"docs/brand.md"}' },
      { tool: 'fs_read', args: '{"path":"docs/logo.md"}' },
    ],
  });
  const s = r.signals.find((x) => x.kind === 'goal_unrelated');
  assert.ok(s);
  assert.equal(s!.major, true);
});
