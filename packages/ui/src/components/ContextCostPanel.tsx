import { useCallback, useEffect, useRef, useState } from 'react';
import { fetchJSON, putSettings } from '../lib/api';
import { t } from '../lib/i18n';
import { useEscapeToClose } from '../hooks/useEscapeToClose';
import styles from '../styles/ContextCostPanel.module.css';

/*
 * 缓存管理面板（动态上下文与成本）。
 *
 * 名字是"缓存管理"而不是"省钱"：它管的是**这一段会话复用什么上下文**（提示前缀、工具结果、
 * 注入范围），省钱只是结果，而且是不保证的结果 —— 用户要求的那句免责声明就贴在面板底部。
 *
 * 用户要的是「输入 token 定价 → 据此分配最优压缩逻辑 → 取到最小消耗」。面板做三件事，而且把
 * 它们严格分开，因为混在一起就变成了"看一眼就把配置改了"：
 *
 *   1. 看：GET /api/context/plan —— 这一段会话的用量、按**你的定价**算出的花费，以及该动哪一侧。
 *      这一步不改任何东西（压缩会删东西的那种杠杆尤其不能顺手生效）。
 *   2. 存：PUT /api/settings —— 只写档位 / 单价 / 是否允许删历史，而且只有按了「保存」才写。
 *   3. 用：POST /api/context/apply —— 只把"调低推理档位"这一个动作落下去，只降不升。
 *
 * ─────────────────────────────────────────────────────────────────────────────
 * 为什么改成一、二、三这样一条顺序（第二轮返工）
 *
 * 上一版把控件按"数据种类"排：单价一块、档位一块、用量一块、建议一块、按钮两个。对写代码的人
 * 合理，对用户不合理 —— 用户的反馈是「根本看不明白怎么用」，因为一屏里没有任何一处告诉他
 * **先做哪个、做完会发生什么**，两个按钮之间也没有关系说明。
 *
 * 现在按**用户要走的步骤**排：先填价 → 再选力度 → 最后看效果并应用。每步都有编号和一句话说明
 * "这步是干什么的、不填会怎样"。三条刻意的规则：
 *
 *   - **没填单价时不显示 $0.00，而是明说"填了才有金额"**。把"未知"印成"免费"是这面板最不能犯的错。
 *   - **档位按钮带一句人话解释**，而不是只有"均衡/激进"这种形容词 —— 用户不知道「均衡」到底均衡了什么。
 *   - **只有真正可点的东西才长得像控件**；建议列表是状态徽标，并在标题里写明"不可点选"。
 * ─────────────────────────────────────────────────────────────────────────────
 */

type CompressionChoice = 'off' | 'light' | 'balanced' | 'aggressive' | 'auto';
type ThinkingLevel = 'none' | 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';

interface Lever {
  id: string;
  title: string;
  applies: boolean;
  side: 'input' | 'output';
  destructive: boolean;
  why: string;
}

interface CostBreakdown {
  freshInput: number;
  cachedInput: number;
  output: number;
  total: number;
}

interface Allocation {
  /** `auto` 已经解出来的实际档位（也就是"按你填的价，该压多狠"）。 */
  level: 'off' | 'light' | 'balanced' | 'aggressive';
  requested: CompressionChoice;
  heavierSide: 'input' | 'output' | 'even';
  cost: CostBreakdown;
  levers: Lever[];
  recommendedThinkingLevel: ThinkingLevel | null;
  historyReduction: boolean;
  disclaimer: string;
}

interface ContextPlan {
  pricing: { inputPerMillion: number; outputPerMillion: number; cachedInputPerMillion: number };
  pricingConfigured: boolean;
  pricingNote: string;
  compression: CompressionChoice;
  allowHistoryReduction: boolean;
  usage: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
    reasoning_tokens?: number;
    cache_hit_tokens?: number;
    cache_miss_tokens?: number;
  };
  allocation: Allocation;
}

/**
 * 档位的中文名，**渲染时构造**而不是写成模块级常量表。
 *
 * 一张 `{ off: '关闭', … }` 的常量表在 i18n 检查眼里就是五个没人翻译的中文字符串；写成
 * `t('关闭')` 才算"已翻译"。同理，语言切换要立刻生效，就必须在渲染时读当前语言。
 */
function levelLabel(id: 'off' | 'light' | 'balanced' | 'aggressive'): string {
  switch (id) {
    case 'off':
      return t('关闭');
    case 'light':
      return t('轻度');
    case 'balanced':
      return t('均衡');
    case 'aggressive':
      return t('激进');
  }
}

/**
 * 每个档位到底做了什么，用人话写一句。
 *
 * 这些句子必须和 `packages/agent-runtime/src/context-budget.ts` 的 `allocateContext` 一致 ——
 * 那一处决定杠杆，这一处只是把它说给用户听。形容词（"均衡"）不给信息，所以每个都配一句"会动什么、
 * 不会动什么"，让用户能凭这句话选，而不是凭哪个词听起来温和。
 */
function levelMeaning(id: CompressionChoice): string {
  switch (id) {
    case 'auto':
      return t('按你填的单价和本会话的实际用量自动定档：钱压在哪一侧，就往那一侧收。');
    case 'off':
      return t('本轮什么都不压缩，上下文原样发给模型。最稳，也最贵。');
    case 'light':
      return t('只收紧"注入哪些文件/符号/知识库命中"，工具结果与历史都不动。');
    case 'balanced':
      return t('在「轻度」基础上再裁工具结果（知识库摘录、命令输出）。只影响本轮发送的内容，磁盘上已保存的记录一条都不改。');
    case 'aggressive':
      return t('输入侧压到最狠。只有你在本页勾选「允许压缩历史记录」时，才会真的减少发送的历史对话。');
  }
}

function thinkingLabel(level: ThinkingLevel): string {
  switch (level) {
    case 'none':
      return t('不思考');
    case 'minimal':
      return t('极少');
    case 'low':
      return t('低');
    case 'medium':
      return t('中');
    case 'high':
      return t('高');
    case 'xhigh':
      return t('很高');
    case 'max':
      return t('最高');
  }
}

/**
 * 只有服务端没回这句话时才用（比如界面更新了而服务端还是旧进程）。
 *
 * 正常情况下渲染的是 `plan.allocation.disclaimer` —— 单一来源在 `packages/agent-runtime` 里，
 * 这份副本存在的唯一理由是"旧服务端也别说空话"。
 */
function fallbackDisclaimer(): string {
  return t(
    '该功能尽量为您减少开支，但不保证不会使您的开支增加：压缩会让模型为了补上被省掉的上下文而多跑几轮，'
    + '那几轮同样要花钱。请对照账单核对，不要只信这里估算。',
  );
}

/** 单价是每 100 万 token 的美元数；一轮对话常是千分之几美元，所以四位小数才有信息量。 */
function money(v: number): string {
  return `$${v.toFixed(4)}`;
}

function int(v: number | undefined): string {
  return (v ?? 0).toLocaleString();
}

/** 一个带编号的步骤标题。编号是这版的主要导航手段，所以它是个组件而不是每处手抄一遍。 */
function Step({ n, title, hint }: { n: number; title: string; hint?: string }) {
  return (
    <div className={styles.stepHead}>
      <span className={styles.stepNo} aria-hidden>{n}</span>
      <div className={styles.stepText}>
        <span className={styles.stepTitle}>{title}</span>
        {hint ? <span className={styles.stepHint}>{hint}</span> : null}
      </div>
    </div>
  );
}

export function ContextCostPanel({ onClose }: { onClose: () => void }) {
  // Esc 关闭。走这个 hook 而不是自己听 keydown：App 里那个 `else if (showCost)` 链是"按 Esc 收
  // 起面板"的兜底，`useEscapeToClose` 会 preventDefault，链上的分支就不会再往下掉。
  useEscapeToClose(onClose);

  const [plan, setPlan] = useState<ContextPlan | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  /*
   * 面板上的草稿值。用字符串，理由见文件头；`null` 表示"还没从服务端拿到"，
   * 这样草稿不会被一次失败的请求清成空。
   */
  const [priceIn, setPriceIn] = useState('');
  const [priceOut, setPriceOut] = useState('');
  const [priceCached, setPriceCached] = useState('');
  const [level, setLevel] = useState<CompressionChoice | null>(null);
  const [allowHistory, setAllowHistory] = useState<boolean | null>(null);

  /**
   * 用户是否动过草稿。
   *
   * 面板每 5 秒拉一次「这一段花了多少钱」（轮次跑着的时候数字确实在变），但**不能**顺手把用户
   * 正在填的单价覆盖回去 —— 那种"界面自己改我的输入"是最让人放弃一个设置页的原因。
   * 所以：脏了就不回填，只有保存成功后才清脏。
   */
  const dirty = useRef(false);

  const load = useCallback(async (opts: { force?: boolean } = {}) => {
    try {
      const data = await fetchJSON<ContextPlan>('/api/context/plan');
      setPlan(data);
      setError(null);
      if (!dirty.current || opts.force) {
        /*
         * 单价全是 0 的时候**显示空白**，不是 "0"。
         *
         * 服务端确实会把 0 原样回传（它必须能区分"用户填了 0"和"没填"），但界面上把一个没填过的
         * 0 印在输入框里，用户看到的是"我填了个 0"——于是这个面板的第一个印象就是一句假话。
         * 有单价了才照实显示，包括那时确实是 0 的格子（"缓存没有优惠"是一个真实的值）。
         */
        const configured = data.pricingConfigured === true;
        const show = (v: number | undefined) => (configured ? String(v ?? 0) : '');
        setPriceIn(show(data.pricing?.inputPerMillion));
        setPriceOut(show(data.pricing?.outputPerMillion));
        setPriceCached(show(data.pricing?.cachedInputPerMillion));
        setLevel(data.compression);
        setAllowHistory(data.allowHistoryReduction);
        dirty.current = false;
      }
    } catch (e) {
      setError((e as Error).message);
    }
  }, []);

  useEffect(() => {
    void load();
    /*
     * 5 秒一轮。刷新频率是这门面板的可用性问题：轮次跑着的时候金额一直在变，10 秒的间隔会让
     * 用户看完一个数字再抬头发现它已经旧了 —— 而这门面板唯一的承诺就是"这个数与账单对得上"。
     * 代价很低（一次 GET，服务端只读，见 `context-budget-check` 第 6 节），所以取更快的一档。
     */
    const timer = window.setInterval(() => void load(), 5000);
    return () => window.clearInterval(timer);
  }, [load]);

  /** 空字符串 = 用户没填这一格，原样送空，让服务端保留旧值（见 PUT /api/settings 的逐格判断）。 */
  const priceBody = () => ({
    inputPerMillion: priceIn.trim() === '' ? undefined : Number(priceIn),
    outputPerMillion: priceOut.trim() === '' ? undefined : Number(priceOut),
    cachedInputPerMillion: priceCached.trim() === '' ? undefined : Number(priceCached),
  });

  async function save() {
    if (level === null) return;
    setBusy(true);
    setMsg(null);
    try {
      const body: Record<string, unknown> = {
        compression: level,
        pricing: priceBody(),
      };
      // 唯一一个会删用户东西的开关：只有界面确实加载过它（`!== null`）才写，
      // 免得"面板还没加载完就按保存"把它悄悄关掉或打开。
      if (allowHistory !== null) body.allowHistoryReduction = allowHistory;
      await putSettings<{ ok: boolean }>(body);
      await load({ force: true });
      setMsg(t('已保存'));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  /**
   * 只应用"调低推理档位"。
   *
   * 会删历史的杠杆（历史压缩）不在这里 —— 它必须由设置里那个显式开关决定，让一个叫"应用建议"的
   * 按钮顺手允许删历史，是这个面板最不该有的行为。
   */
  async function applyRecommendation() {
    setBusy(true);
    setMsg(null);
    try {
      const res = await fetchJSON<{ ok: boolean; applied: ThinkingLevel | null }>('/api/context/apply', {
        method: 'POST',
        body: {},
      });
      await load({ force: true });
      setMsg(res.applied
        ? t('推理档位已下调至「{level}」', { level: thinkingLabel(res.applied) })
        : t('本轮没有可调整的项'));
    } catch (e) {
      setMsg((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const alloc = plan?.allocation;
  const recommended = alloc?.recommendedThinkingLevel ?? null;
  const configured = plan?.pricingConfigured === true;
  const inputCost = (alloc?.cost.freshInput ?? 0) + (alloc?.cost.cachedInput ?? 0);

  /*
   * 这一句就是"现在是什么状态"的总结，放在最上面。
   *
   * 用户抱怨看不懂，根本原因是打开面板后要先自己把下面五块拼起来才知道结论。这四个数就是拼完的
   * 结论，所以它必须出现在第一屏，而不是分散在各节里。
   */
  const sideText = alloc?.heavierSide === 'output'
    ? t('输出侧')
    : alloc?.heavierSide === 'input' ? t('输入侧') : t('两侧相当');

  return (
    <div className={styles.backdrop} onClick={onClose}>
      <div className={styles.panel} onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div>
            <div className={styles.title}>{t('缓存管理')}</div>
            <div className={styles.subtitle}>
              {t('先填单价，再选压缩力度，最后应用。三步之后这里能告诉你：这段会话花了多少、下轮该省哪一侧。')}
            </div>
          </div>
          <button type="button" className={styles.close} onClick={onClose} title={t('关闭')}>×</button>
        </header>

        <div className={styles.body}>
          {error ? <div className={styles.error}>{error}</div> : null}

          {/* ── 结论条：把结论提到最上面 ── */}
          <div className={styles.summary}>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>{t('本会话合计')}</span>
              <span className={styles.summaryValue}>
                {configured ? money(alloc?.cost.total ?? 0) : '—'}
              </span>
            </div>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>{t('钱在哪一侧')}</span>
              <span className={styles.summaryValue}>{sideText}</span>
            </div>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>{t('当前档位')}</span>
              <span className={styles.summaryValue}>
                {alloc ? levelLabel(alloc.level) : '—'}
                {alloc?.requested === 'auto' ? <em className={styles.summaryAuto}>{t('（自动）')}</em> : null}
              </span>
            </div>
            <div className={styles.summaryCell}>
              <span className={styles.summaryLabel}>{t('会删历史吗')}</span>
              <span className={styles.summaryValue}>
                {alloc?.historyReduction ? t('会') : t('不会')}
              </span>
            </div>
          </div>

          {/* ── 第 1 步：单价 ── */}
          <section className={styles.section}>
            <Step
              n={1}
              title={t('填单价')}
              hint={t('去你供应商的定价页抄三个数填进来，单位是「每 100 万 token」。不填就只显示 token 用量，不算钱。')}
            />
            <div className={styles.priceRow}>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('输入')}</span>
                <input
                  className={styles.fieldInput}
                  inputMode="decimal"
                  value={priceIn}
                  onChange={(e) => { dirty.current = true; setPriceIn(e.target.value); }}
                  placeholder={t('例如 3')}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('输出')}</span>
                <input
                  className={styles.fieldInput}
                  inputMode="decimal"
                  value={priceOut}
                  onChange={(e) => { dirty.current = true; setPriceOut(e.target.value); }}
                  placeholder={t('例如 15')}
                />
              </label>
              <label className={styles.field}>
                <span className={styles.fieldLabel}>{t('缓存命中')}</span>
                <input
                  className={styles.fieldInput}
                  inputMode="decimal"
                  value={priceCached}
                  onChange={(e) => { dirty.current = true; setPriceCached(e.target.value); }}
                  placeholder={t('选填')}
                />
              </label>
            </div>
            <p className={styles.note}>{plan?.pricingNote ?? t('正在读取单价…')}</p>
          </section>

          {/* ── 第 2 步：压缩力度 ── */}
          <section className={styles.section}>
            <Step
              n={2}
              title={t('选压缩力度')}
              hint={t('不确定就留「自动」：它会按上面填的单价和本会话实际用量自己决定压多狠。')}
            />
            <div className={styles.levels}>
              {(['auto', 'off', 'light', 'balanced', 'aggressive'] as CompressionChoice[]).map((id) => (
                <button
                  key={id}
                  type="button"
                  /*
                   * `data-active` 而不是只加 class：control-style 检查要求可点控件在选中态有可见
                   * 差异，把状态写成属性也让 CSS 和测试都能读到同一份事实。
                   */
                  data-active={level === id ? 'true' : 'false'}
                  className={styles.levelBtn}
                  onClick={() => { dirty.current = true; setLevel(id); }}
                >
                  <span className={styles.levelName}>
                    {id === 'auto' ? t('自动') : levelLabel(id)}
                    {alloc?.requested === id && id === 'auto' ? (
                      <em className={styles.levelNow}>{t('当前 → {level}', { level: levelLabel(alloc.level) })}</em>
                    ) : null}
                  </span>
                  <span className={styles.levelDesc}>{levelMeaning(id)}</span>
                </button>
              ))}
            </div>
          </section>

          {/* ── 第 3 步：效果 ── */}
          <section className={styles.section}>
            <Step
              n={3}
              title={t('看这段会话的用量与效果')}
              hint={t('下面是只读的：这一段已经花了多少，以及本轮各项压缩会不会生效。')}
            />
            <div className={styles.costGrid}>
              <span className={styles.costLabel}>{t('输入 token')}</span>
              <span className={styles.costValue}>{int(plan?.usage.prompt_tokens)}</span>
              <span className={styles.costLabel}>{t('其中缓存命中')}</span>
              <span className={styles.costValue}>{int(plan?.usage.cache_hit_tokens)}</span>
              <span className={styles.costLabel}>{t('输出 token')}</span>
              <span className={styles.costValue}>{int(plan?.usage.completion_tokens)}</span>
              <span className={styles.costLabel}>{t('其中推理 token')}</span>
              <span className={styles.costValue}>{int(plan?.usage.reasoning_tokens)}</span>
            </div>
            <div className={styles.costGrid}>
              <span className={styles.costLabel}>{t('输入花费')}</span>
              <span className={styles.costValue}>{configured ? money(inputCost) : '—'}</span>
              <span className={styles.costLabel}>{t('输出花费')}</span>
              <span className={styles.costValue}>{configured ? money(alloc?.cost.output ?? 0) : '—'}</span>
              <span className={styles.costLabel}>{t('合计')}</span>
              <span className={styles.costTotal}>{configured ? money(alloc?.cost.total ?? 0) : '—'}</span>
            </div>
            {!configured ? (
              <p className={styles.callout}>
                {t('还没填单价，所以上面不显示金额 —— 显示 $0.00 会让你以为这段免费，那是错的。填上第 1 步的三个数就会出现。')}
              </p>
            ) : null}

            <div className={styles.subHead}>
              {t('本轮各项压缩的实际状态（不可点选，要调请用上面的档位与开关）')}
            </div>
            <ul className={styles.levers}>
              {(alloc?.levers ?? []).map((l) => (
                <li key={l.id} className={`${styles.lever}${l.applies ? ` ${styles.leverOn}` : ''}`}>
                  <span className={styles.leverTitle}>
                    <span className={`${styles.leverState}${l.applies ? ` ${styles.leverStateOn}` : ''}`}>
                      {l.applies ? t('已生效') : t('本轮不适用')}
                    </span>
                    <span className={styles.leverName}>{t(l.title)}</span>
                    {l.destructive ? <em className={styles.danger}>{t('有损')}</em> : null}
                  </span>
                  <span className={styles.leverWhy}>{l.why}</span>
                </li>
              ))}
            </ul>
          </section>

          {/* ── 历史：唯一会删东西的开关，单独一节 ── */}
          <section className={styles.section}>
            <label className={styles.checkRow}>
              <input
                type="checkbox"
                checked={allowHistory === true}
                onChange={(e) => { dirty.current = true; setAllowHistory(e.target.checked); }}
              />
              <span>
                {t('允许压缩历史记录（会减少发送的对话内容）')}
                <em className={styles.warn}>
                  {t('默认关闭：被压缩掉的历史模型无法再看到，往往需要重新检索，反而增加成本。')}
                </em>
              </span>
            </label>
            <p className={styles.note}>
              {alloc?.historyReduction
                ? t('本轮会压缩历史记录（已允许，且档位为「激进」）。')
                : t('本轮不压缩任何历史记录。')}
            </p>
          </section>

          {/* ── 免责声明：用户要求逐字出现，服务端随 plan 下发 ── */}
          <p className={styles.disclaimer}>{alloc?.disclaimer ?? fallbackDisclaimer()}</p>

          {/*
            * 两个按钮的关系是上一版最没说清的地方，所以这里各配一句。
            * 「保存设置」= 把上面选的档位/单价写进 .env（持久，跨会话）；
            * 「应用建议」= 只把本轮推理档位降一档（一次性，不写配置）。
            */}
          <div className={styles.actions}>
            <button type="button" className={styles.saveBtn} disabled={busy} onClick={() => void save()}>
              {busy ? t('处理中…') : t('保存设置')}
            </button>
            <span className={styles.actionHint}>{t('保存档位与单价，跨会话有效')}</span>
            <button
              type="button"
              className={styles.applyBtn}
              disabled={busy || !recommended}
              title={recommended
                ? t('把推理档位下调至「{level}」', { level: thinkingLabel(recommended) })
                : t('本轮无需调整推理档位')}
              onClick={() => void applyRecommendation()}
            >
              {recommended
                ? t('应用建议：推理档位降至「{level}」', { level: thinkingLabel(recommended) })
                : t('本轮无需调整')}
            </button>
            <span className={styles.actionHint}>{t('只本轮生效，不改配置')}</span>
            {msg ? <span className={styles.msg}>{msg}</span> : null}
          </div>
        </div>
      </div>
    </div>
  );
}
