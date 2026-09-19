import { useCallback, useEffect, useMemo, useState } from 'react';
import { fetchJSON, streamSSE } from '../lib/api';
import { toast } from '../lib/toast';
import styles from '../styles/Cluster.module.css';
import { useEscapeToClose } from '../hooks/useEscapeToClose';

export interface ClusterRole {
  key: string;
  name: string;
  title: string;
  count: number;
  skill: string;
  phase: 'lead' | 'work' | 'review';
  hue: number;
  isCustom?: boolean;
}

interface ClusterMember {
  id: string;
  roleKey: string;
  name: string;
  title: string;
  phase: 'lead' | 'work' | 'review';
  hue: number;
}

interface ClusterMessage {
  id: string;
  role: string;
  name: string;
  content: string;
  created_at: string;
  parallel_group?: string;
}

interface ClusterRoom {
  id: string;
  title: string;
  status: string;
  roles: ClusterRole[];
  members: ClusterMember[];
  messages: ClusterMessage[];
  last_error?: string;
}

interface RolePreset {
  key: string;
  name: string;
  title: string;
  phase: 'lead' | 'work' | 'review';
  hue: number;
}

type MemberState = 'idle' | 'running' | 'done' | 'error';

const PHASE_LABEL: Record<string, string> = {
  lead: '指挥',
  work: '产出',
  review: '审查',
};

export function ClusterPanel({
  onClose,
  focusRoomId,
  onRoomsChanged,
}: {
  onClose: () => void;
  focusRoomId?: string | null;
  /** Fired whenever rooms are created/renamed/deleted, so the session rail updates. */
  onRoomsChanged?: () => void;
}) {
  // Escape closes this dialog: the backdrop click is a mouse convenience, not a keyboard path.
  useEscapeToClose(onClose);

  const [rooms, setRooms] = useState<ClusterRoom[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [room, setRoom] = useState<ClusterRoom | null>(null);
  const [goal, setGoal] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState('');
  const [phase, setPhase] = useState('');
  const [memberState, setMemberState] = useState<Record<string, MemberState>>({});
  const [presets, setPresets] = useState<RolePreset[]>([]);
  const [showRoles, setShowRoles] = useState(false);
  const [newRole, setNewRole] = useState<{ name: string; title: string; phase: 'lead' | 'work' | 'review'; requirement: string }>({
    name: '',
    title: '',
    phase: 'work',
    requirement: '',
  });
  const [genBusy, setGenBusy] = useState(false);

  const refreshList = useCallback(async () => {
    const data = await fetchJSON<{ rooms: ClusterRoom[] }>('/api/cluster/rooms');
    setRooms(data.rooms || []);
  }, []);

  const loadRoom = useCallback(async (id: string) => {
    const r = await fetchJSON<ClusterRoom>(`/api/cluster/rooms/${id}`);
    setRoom(r);
    setActiveId(id);
  }, []);

  useEffect(() => {
    refreshList().catch((e) => setStatus(String(e.message || e)));
    fetchJSON<{ presets: RolePreset[] }>('/api/cluster/role-presets')
      .then((d) => setPresets(d.presets ?? []))
      .catch(() => undefined);
  }, [refreshList]);

  // Open a specific room when the panel was launched from the session rail.
  useEffect(() => {
    if (focusRoomId) void loadRoom(focusRoomId);
  }, [focusRoomId, loadRoom]);

  /** Members grouped by phase, for the progress strip. */
  const memberStrip = useMemo(() => room?.members ?? [], [room]);

  async function createRoom() {
    const r = await fetchJSON<ClusterRoom>('/api/cluster/rooms', {
      method: 'POST',
      body: { title: '工作群' },
    });
    await refreshList();
    setRoom(r);
    setActiveId(r.id);
    // A new room must appear in the session rail immediately; without this it
    // looked like the group had never been created.
    onRoomsChanged?.();
  }

  async function saveRoles(roles: ClusterRole[]) {
    if (!activeId) return;
    const r = await fetchJSON<ClusterRoom>(`/api/cluster/rooms/${activeId}/roles`, {
      method: 'PUT',
      body: { roles },
    });
    setRoom(r);
    await refreshList();
  }

  async function addRole(preset?: RolePreset) {
    if (!activeId) return;
    const payload = preset
      ? { ...preset, count: 1, skill: '' }
      : {
          name: newRole.name.trim(),
          title: newRole.title.trim() || newRole.name.trim(),
          phase: newRole.phase,
          count: 1,
          skill: '',
          requirement: newRole.requirement.trim(),
        };
    if (!payload.name) return;
    setGenBusy(true);
    setStatus('正在生成角色 skill…');
    try {
      const r = await fetchJSON<{ room: ClusterRoom }>(`/api/cluster/rooms/${activeId}/roles`, {
        method: 'POST',
        body: payload,
      });
      setRoom(r.room);
      setNewRole({ name: '', title: '', phase: 'work', requirement: '' });
      await refreshList();
      setStatus('角色已添加');
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setGenBusy(false);
    }
  }

  async function removeRole(key: string) {
    if (!activeId) return;
    const r = await fetchJSON<ClusterRoom>(`/api/cluster/rooms/${activeId}/roles/${encodeURIComponent(key)}`, {
      method: 'DELETE',
    });
    setRoom(r);
    await refreshList();
  }

  async function runWave() {
    if (!activeId || !goal.trim() || busy) return;
    setBusy(true);
    setStatus('并行波次运行中…');
    setPhase('启动');
    setMemberState({});
    const id = activeId;
    try {
      await new Promise<void>((resolve, reject) => {
        streamSSE(
          `/api/cluster/rooms/${id}/run`,
          { goal: goal.trim(), stream: true },
          {
            onData: (chunk: any) => {
              if (chunk.phase) setPhase(String(chunk.phase));
              if (chunk.type === 'status' && chunk.content) setStatus(String(chunk.content));
              if (chunk.type === 'error') {
                setStatus(String(chunk.error || 'error'));
                if (chunk.member) setMemberState((s) => ({ ...s, [chunk.member]: 'error' }));
              }
              if (chunk.member && chunk.memberState) {
                setMemberState((s) => ({ ...s, [chunk.member]: chunk.memberState as MemberState }));
              } else if (chunk.member && chunk.type === 'status') {
                const text = String(chunk.content || '');
                if (/开始|running/i.test(text)) setMemberState((s) => ({ ...s, [chunk.member]: 'running' }));
                else if (/完成|done/i.test(text)) setMemberState((s) => ({ ...s, [chunk.member]: 'done' }));
              }
              if (chunk.type === 'room' && chunk.room) setRoom(chunk.room as ClusterRoom);
              if (chunk.type === 'done') setStatus('本波完成');
            },
            onError: (err) => reject(err),
            onDone: () => resolve(),
          },
        );
      });
      await loadRoom(id);
      await refreshList();
    } catch (e) {
      setStatus((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function exportKb() {
    if (!activeId) return;
    setStatus('导入讨论纪要到知识库…');
    try {
      const res = await fetchJSON<{ groupPath: string; messages: number }>(
        `/api/cluster/rooms/${activeId}/export-kb`,
        { method: 'POST', body: { title: room?.title || '讨论纪要' } },
      );
      setStatus(`已导入知识库 ${res.groupPath}（${res.messages} 条）`);
    } catch (e) {
      setStatus((e as Error).message);
    }
  }

  const stateClass = (s: MemberState) =>
    s === 'running' ? styles.mRunning : s === 'done' ? styles.mDone : s === 'error' ? styles.mError : styles.mIdle;

  return (
    <div className={styles.backdrop} data-surface="backdrop" onClick={onClose}>
      <div className={styles.panel} data-surface="panel" onClick={(e) => e.stopPropagation()}>
        <header className={styles.header}>
          <div>
            <h2 className={styles.title}>自动化工作群</h2>
            <p className={styles.sub}>
              一个 API、多个智能体在一个群里干活，你也在群里。角色数量与分工都可自定义。
            </p>
          </div>
          <button type="button" className={styles.close} onClick={onClose}>Esc</button>
        </header>

        <div className={styles.body}>
          {/* ── left: room list ── */}
          <aside className={styles.rail}>
            <button type="button" className={styles.primaryBtn} onClick={() => void createRoom()}>
              + 新建工作群
            </button>
            {rooms.length === 0 ? <p className={styles.hint}>还没有工作群。</p> : null}
            {rooms.map((x) => (
              <button
                key={x.id}
                type="button"
                className={`${styles.roomItem} ${activeId === x.id ? styles.roomItemOn : ''}`}
                onClick={() => void loadRoom(x.id)}
              >
                <span className={styles.roomName}>{x.title}</span>
                <span className={styles.roomMeta}>
                  {x.members?.length ?? 0} 人 · {x.status}
                </span>
              </button>
            ))}
          </aside>

          {/* ── right: room detail ── */}
          <section className={styles.main}>
            {!room ? (
              <div className={styles.placeholder}>
                <div className={styles.placeholderIcon}>◇</div>
                <div className={styles.placeholderText}>新建或选择一个工作群</div>
                <div className={styles.placeholderHint}>
                  流程：指挥拆解 → 产出角色并行 → 审查 → 指挥汇总
                </div>
              </div>
            ) : (
              <>
                <div className={styles.roomHeader}>
                  <input
                    className={styles.roomTitleInput}
                    value={room.title}
                    onChange={(e) => setRoom({ ...room, title: e.target.value })}
                    onBlur={() => {
                      void fetchJSON(`/api/cluster/rooms/${room.id}/title`, {
                        method: 'PUT',
                        body: { title: room.title },
                      }).then(() => refreshList());
                    }}
                  />
                  <button
                    type="button"
                    className={styles.ghostBtn}
                    onClick={() => setShowRoles((v) => !v)}
                  >
                    {showRoles ? '收起角色设置' : '角色设置'}
                  </button>
                  <span className={styles.roomStatus}>
                    {phase ? `阶段：${phase}` : room.status}
                    {status ? ` · ${status}` : ''}
                  </span>
                </div>

                {/* ── role configuration ── */}
                {showRoles ? (
                  <div className={styles.roleEditor}>
                    <div className={styles.roleEditorHead}>角色与数量（0 = 不参与）</div>
                    <div className={styles.roleGrid}>
                      {room.roles.map((r) => (
                        <div key={r.key} className={styles.roleCard}>
                          <span className={styles.roleDot} style={{ background: `hsl(${r.hue} 68% 56%)` }} />
                          <div className={styles.roleInfo}>
                            <div className={styles.roleName}>
                              {r.name}
                              {r.isCustom ? <em className={styles.roleCustom}>自定义</em> : null}
                            </div>
                            <div className={styles.roleTitle}>{r.title}</div>
                          </div>
                          <div className={styles.counter}>
                            <button
                              type="button"
                              disabled={r.count <= 0}
                              onClick={() => void saveRoles(room.roles.map((x) => (x.key === r.key ? { ...x, count: x.count - 1 } : x)))}
                            >−</button>
                            <span className={styles.countVal}>{r.count}</span>
                            <button
                              type="button"
                              disabled={r.count >= 9}
                              onClick={() => void saveRoles(room.roles.map((x) => (x.key === r.key ? { ...x, count: x.count + 1 } : x)))}
                            >+</button>
                          </div>
                          {r.isCustom ? (
                            <button type="button" className={styles.roleDel} onClick={() => void removeRole(r.key)} title="删除角色">×</button>
                          ) : null}
                        </div>
                      ))}
                    </div>

                    <div className={styles.roleAddRow}>
                      <span className={styles.roleAddLabel}>快速添加</span>
                      {presets
                        .filter((p) => !room.roles.some((r) => r.key === p.key))
                        .map((p) => (
                          <button
                            key={p.key}
                            type="button"
                            className={styles.presetChip}
                            disabled={genBusy}
                            onClick={() => void addRole(p)}
                            title={`${p.title}（${PHASE_LABEL[p.phase]}）`}
                          >
                            + {p.name}
                          </button>
                        ))}
                    </div>

                    <div className={styles.customRole}>
                      <div className={styles.roleAddLabel}>自定义角色</div>
                      <div className={styles.customRow}>
                        <input
                          className={styles.input}
                          placeholder="名称，例如：法务"
                          value={newRole.name}
                          onChange={(e) => setNewRole({ ...newRole, name: e.target.value })}
                        />
                        <input
                          className={styles.input}
                          placeholder="职责一句话"
                          value={newRole.title}
                          onChange={(e) => setNewRole({ ...newRole, title: e.target.value })}
                        />
                        <select
                          className={styles.select}
                          value={newRole.phase}
                          onChange={(e) => setNewRole({ ...newRole, phase: e.target.value as 'lead' | 'work' | 'review' })}
                        >
                          <option value="lead">指挥</option>
                          <option value="work">产出</option>
                          <option value="review">审查</option>
                        </select>
                      </div>
                      <textarea
                        className={styles.textarea}
                        rows={2}
                        placeholder="想让它干什么？（可留空，AI 会按名称与职责自动生成 skill）"
                        value={newRole.requirement}
                        onChange={(e) => setNewRole({ ...newRole, requirement: e.target.value })}
                      />
                      <button
                        type="button"
                        className={styles.primaryBtn}
                        disabled={genBusy || !newRole.name.trim()}
                        onClick={() => void addRole()}
                      >
                        {genBusy ? '生成 skill 中…' : '添加角色（AI 生成 skill）'}
                      </button>
                    </div>
                  </div>
                ) : null}

                {/* ── member strip ── */}
                <div className={styles.strip}>
                  {memberStrip.map((m) => {
                    const st = memberState[m.id] || 'idle';
                    return (
                      <div key={m.id} className={`${styles.memberChip} ${stateClass(st)}`} title={m.title}>
                        <span className={styles.memberAvatar} style={{ background: `hsl(${m.hue} 68% 56%)` }}>
                          {m.name.slice(0, 1)}
                        </span>
                        <span className={styles.memberName}>{m.name}</span>
                        <span className={styles.memberPhase}>{PHASE_LABEL[m.phase]}</span>
                      </div>
                    );
                  })}
                </div>

                {/* ── transcript ── */}
                <div className={styles.transcript}>
                  {room.messages.length === 0 ? (
                    <div className={styles.placeholderHint}>下发目标后，群成员会依次/并行发言。</div>
                  ) : (
                    room.messages.map((m) => (
                      <div key={m.id} className={styles.msg}>
                        <div className={styles.msgHead}>
                          <strong className={styles.msgName}>{m.name}</strong>
                          {m.parallel_group ? <span className={styles.msgTag}>并行</span> : null}
                        </div>
                        <div className={styles.msgBody}>{m.content}</div>
                      </div>
                    ))
                  )}
                </div>

                <textarea
                  className={styles.goalInput}
                  value={goal}
                  onChange={(e) => setGoal(e.target.value)}
                  rows={3}
                  placeholder="下发本波目标，例如：为 SHE 写一份夜间巡检脚本的用户说明"
                />
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={styles.primaryBtn}
                    disabled={busy || !goal.trim()}
                    onClick={() => void runWave()}
                  >
                    {busy ? '并行运行中…' : '跑一波'}
                  </button>
                  <button type="button" className={styles.ghostBtn} disabled={!room.messages.length} onClick={() => void exportKb()}>
                    纪要导入知识库
                  </button>
                  {room.last_error ? <span className={styles.err}>{room.last_error}</span> : null}
                </div>
              </>
            )}
          </section>
        </div>
      </div>
    </div>
  );
}
