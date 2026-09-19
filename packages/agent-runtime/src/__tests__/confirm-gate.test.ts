/**
 * The confirmation gate must not be self-service.
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * THE HOLE
 *
 * A dangerous tool call issued without a ticket returns `needs_confirm` plus a freshly issued
 * ticket id. The agent pushed that raw result into `history`, which is what the model reads next —
 * so the model could call `shell`, read the ticket out of its own tool result, and immediately call
 * again with `_confirm_ticket` set. `ConfirmTicketStore.consume` checks the tool name, an argument
 * fingerprint (which deliberately ignores `_`-prefixed keys, so adding the ticket does not change
 * it) and a TTL — nothing ties redemption to a person.
 *
 * A prompt-injected agent could therefore approve its own dangerous command, and the user never saw
 * a prompt. The gate only gated the honest path.
 *
 * Two independent fixes, both pinned here:
 *   1. the ticket is redacted out of what the model is shown;
 *   2. a `_confirm_ticket` arriving FROM the model is discarded, whatever its provenance.
 * ─────────────────────────────────────────────────────────────────────────────
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Agent } from '../agent.js';
import type { LLMMessage, StreamChunk, ToolDefinition, LLMProvider } from '@she/shared';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'she-confirm-'));
  mkdirSync(join(dir, '.she'), { recursive: true });
});
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

/**
 * A tool that asks for confirmation on the first call and records every argument set it is given.
 *
 * Deliberately not the real `shell` tool: the question here is what reaches the EXECUTOR, and this
 * makes that observable without depending on the sandbox's own policy.
 */
function makeConfirmTools() {
  const seenArgs: Array<Record<string, unknown>> = [];
  const defs: ToolDefinition[] = [{
    name: 'danger',
    description: 'A dangerous action that requires confirmation.',
    parameters: { type: 'object', properties: { target: { type: 'string' } }, required: [] },
    isDangerous: true,
  }];

  const execute = async (_name: string, args: Record<string, unknown>): Promise<string> => {
    seenArgs.push({ ...args });
    const ticket = typeof args._confirm_ticket === 'string' ? args._confirm_ticket : undefined;
    if (!ticket) {
      return JSON.stringify({
        needs_confirm: {
          ticket_id: 'TICKET-SECRET-123',
          tool: 'danger',
          summary: 'danger',
          created_at: new Date().toISOString(),
          expires_at: new Date(Date.now() + 60_000).toISOString(),
        },
        hint: 'Re-run with args._confirm_ticket set to ticket_id after user approval',
      });
    }
    return JSON.stringify({ ok: true, executed: true, target: args.target });
  };

  return { defs, execute, seenArgs };
}

/** A provider that plays a fixed sequence of tool calls, then stops. */
class ScriptedProvider implements LLMProvider {
  name = 'scripted';
  private step = 0;
  /** Everything the model was shown, in order, for assertions about redaction. */
  readonly seenMessages: string[] = [];

  constructor(private readonly scripts: Array<{ name: string; args: unknown }[]>) {}

  async chat(messages: LLMMessage[]): Promise<LLMMessage> {
    for (const m of messages) this.seenMessages.push(`${m.role}:${String(m.content ?? '')}`);

    const calls = this.scripts[this.step];
    if (!calls) return { role: 'assistant', content: 'done' };
    this.step++;
    return {
      role: 'assistant',
      content: '',
      tool_calls: calls.map((c, i) => ({
        id: `call_${this.step}_${i}`,
        type: 'function' as const,
        function: { name: c.name, arguments: JSON.stringify(c.args) },
      })),
    };
  }
}

function makeAgent(provider: LLMProvider, tools: { defs: ToolDefinition[]; execute: (n: string, a: Record<string, unknown>) => Promise<string> }) {
  const cfg = {
    llm: { provider: 'openai', model: 'stub', baseUrl: 'http://x', apiKey: 'k', maxTokens: 100, temperature: 0, thinkingLevel: 'low' },
    workspace: { root: dir },
    kb: {
      dbPath: join(dir, '.she', 'kb.sqlite'),
      maxChildrenBeforeSplit: 12, dormancyThresholdDays: 30, activationBudget: 100, boostOnAccess: 1.5,
      pulseSeed: { initialEnergy: 1, decayRate: 0.3, resonanceThreshold: 0.15, maxHops: 6 },
    },
    skills: { profile: 'dev' },
    automationMode: true,
    server: { port: 0, host: '127.0.0.1' },
    sandbox: { shell: 'auto', timeout: 1000, maxOutputBytes: 1000, denyDestructiveByDefault: true, allowAllCommands: true },
    schedule: { enabled: false, tickSeconds: 30, workingWindow: null },
  };
  const agent = new Agent(
    cfg as never,
    {} as never,
    { definitions: tools.defs, execute: tools.execute } as never,
    null,
  );
  // Same injection the other agent tests use: the constructor builds a real provider from config.
  (agent as unknown as { provider: LLMProvider }).provider = provider;
  return agent;
}

describe('确认票据不能被模型看见', () => {
  it('【关键】票据 ID 不会出现在模型看到的任何消息里', async () => {
    const tools = makeConfirmTools();
    const provider = new ScriptedProvider([
      [{ name: 'danger', args: { target: 'x' } }],
    ]);
    const agent = makeAgent(provider, tools);

    const chunks: StreamChunk[] = [];
    await agent.chat('做那件危险的事', (c) => chunks.push(c));

    const modelSaw = provider.seenMessages.join('\n');
    assert.ok(!modelSaw.includes('TICKET-SECRET-123'),
      `模型看到了票据（可以自己批准自己）：\n${modelSaw.slice(-400)}`);
    // It should still be told the call is waiting, so it does not simply retry blindly.
    assert.match(modelSaw, /awaiting|user_approval|确认/);
  });

  it('票据仍然会送到 UI（确认卡需要它）', async () => {
    const tools = makeConfirmTools();
    const provider = new ScriptedProvider([[{ name: 'danger', args: { target: 'x' } }]]);
    const agent = makeAgent(provider, tools);

    const chunks: StreamChunk[] = [];
    await agent.chat('做那件危险的事', (c) => chunks.push(c));

    const confirmChunk = chunks.find((c) => c.type === 'needs_confirm');
    assert.ok(confirmChunk, '没有向 UI 发出 needs_confirm 事件');
    assert.equal((confirmChunk as { ticket?: { ticket_id?: string } }).ticket?.ticket_id, 'TICKET-SECRET-123');
  });

  it('【关键】模型自己带 _confirm_ticket 会被丢弃', async () => {
    const tools = makeConfirmTools();
    // The model replays the call WITH the ticket — the exact bypass.
    const provider = new ScriptedProvider([
      [{ name: 'danger', args: { target: 'x', _confirm_ticket: 'TICKET-SECRET-123' } }],
    ]);
    const agent = makeAgent(provider, tools);

    await agent.chat('自己批准自己', () => undefined);

    // The executor must have been called without a ticket, so it asked for confirmation again
    // instead of executing.
    for (const args of tools.seenArgs) {
      assert.equal(args._confirm_ticket, undefined,
        `模型自带的票据到达了执行器: ${JSON.stringify(args)}`);
    }
  });

  it('用户确认路径仍然可用（confirmTool 从服务端记录取参数）', async () => {
    const tools = makeConfirmTools();
    const provider = new ScriptedProvider([[{ name: 'danger', args: { target: 'x' } }]]);
    const agent = makeAgent(provider, tools);

    await agent.chat('做那件危险的事', () => undefined);
    const pending = agent.getPendingConfirm();
    assert.ok(pending, '应当有一个待确认项');

    /*
     * This is what the UI does: it posts the ticket to `/api/chat/confirm`, which calls
     * `confirmTool`. The arguments come from the agent's own `lastPending` record, never from the
     * model — which is why the human path is the only one that can carry a ticket.
     */
    await agent.confirmTool(pending!.ticket_id, () => undefined);

    assert.ok(tools.seenArgs.some((a) => a._confirm_ticket === 'TICKET-SECRET-123'),
      '用户确认时票据应当被注入');
    assert.ok(tools.seenArgs.some((a) => a.target === 'x'),
      '确认时应当使用服务端记录的参数，而不是模型重新提交的参数');
  });
});
