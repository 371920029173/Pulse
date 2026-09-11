import { useState, useCallback } from 'react';
import { fetchJSON } from '../lib/api';

export interface GroupTreeNode {
  id: string;
  name: string;
  children: GroupTreeNode[];
  memoryCount: number;
  isDormant: boolean;
}

export interface MemoryNode {
  id: string;
  kind: string;
  title: string;
  content: string;
  groupIds: string[];
  accessCount: number;
  isDormant: boolean;
  createdAt: number;
}

export interface EdgeData {
  id: string;
  kind: string;
  sourceId: string;
  targetId: string;
  weight: number;
  direction: string;
  evidence?: string;
  falsifiers?: string[];
}

export interface GroupDetail {
  id: string;
  name: string;
  parentGroupId: string | null;
  childGroupIds: string[];
  memoryIds: string[];
  competitionSubgroupIds: string[];
  isCompetitionSubgroup: boolean;
  hormoneMarker: number;
  trustConstant: number;
  isDormant: boolean;
  stats: {
    totalMemories: number;
    directMemories: number;
    compressedMemories: number;
    totalChildren: number;
    accessCount: number;
  };
}

export interface GroupDetailResponse {
  group: GroupDetail;
  children: GroupDetail[];
  memories: MemoryNode[];
}

export interface KBStats {
  totalGroups: number;
  totalMemories: number;
  totalEdges: number;
  dormancyRatio: number;
  topMemories: { id: string; title: string; accessCount: number }[];
}

export interface ActivationTrace {
  nodeId: string;
  groupPath: string[];
  pulseSeeds: PulseSeed[];
  activationLevel: number;
  reason: string;
}

export interface PulseSeed {
  id: string;
  sourceNodeId: string | null;
  sourceGroupId: string;
  energy: number;
  origin: string;
  hop: number;
  path: PulseHop[];
  resonatedAt: number;
}

export interface PulseHop {
  fromId: string;
  toId: string;
  edgeId: string | null;
  edgeKind: string;
  energyBefore: number;
  energyAfter: number;
}

export interface KBQueryResult {
  nodes: MemoryNode[];
  traces: ActivationTrace[];
  groupsVisited: string[];
  totalNodesScanned: number;
  queryTimeMs: number;
  pulseSeeds: PulseSeed[];
}

export function useKB() {
  const [tree, setTree] = useState<GroupTreeNode[]>([]);
  const [groups, setGroups] = useState<GroupDetail[]>([]);
  const [stats, setStats] = useState<KBStats | null>(null);
  const [selectedGroup, setSelectedGroup] = useState<GroupDetailResponse | null>(null);
  const [lastQuery, setLastQuery] = useState<KBQueryResult | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchTree = useCallback(async () => {
    try {
      const data = await fetchJSON<{ tree: GroupTreeNode[] }>('/api/kb/tree');
      setTree(data.tree ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const fetchGroups = useCallback(async () => {
    try {
      const data = await fetchJSON<{ groups: GroupDetail[] }>('/api/kb/groups');
      setGroups(data.groups ?? []);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const fetchGroup = useCallback(async (id: string) => {
    setIsLoading(true);
    try {
      const data = await fetchJSON<GroupDetailResponse>(`/api/kb/groups/${id}`);
      setSelectedGroup(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setIsLoading(false);
    }
  }, []);

  const fetchStats = useCallback(async () => {
    try {
      const data = await fetchJSON<KBStats>('/api/kb/stats');
      setStats(data);
      setError(null);
    } catch (err) {
      setError((err as Error).message);
    }
  }, []);

  const queryKB = useCallback(async (query: string, budget?: number) => {
    setIsLoading(true);
    try {
      const data = await fetchJSON<KBQueryResult>('/api/kb/query', {
        method: 'POST',
        body: { query, budget },
      });
      setLastQuery(data);
      setError(null);
      return data;
    } catch (err) {
      setError((err as Error).message);
      return null;
    } finally {
      setIsLoading(false);
    }
  }, []);

  return {
    tree,
    groups,
    stats,
    selectedGroup,
    lastQuery,
    isLoading,
    error,
    fetchTree,
    fetchGroups,
    fetchGroup,
    fetchStats,
    queryKB,
    setSelectedGroup,
    setLastQuery,
  };
}
