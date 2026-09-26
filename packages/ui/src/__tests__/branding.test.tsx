/**
 * Product naming: every place the app names itself says "Pulse".
 *
 * The product used to show up as "SHE" or a lowercase "bot" depending on the
 * screen. These tests pin the visible surfaces (window title, sidebar logo,
 * home wordmark, terminal banner, MCP source label) so an old name cannot creep
 * back in. Identifiers that must stay stable (`@she/*` packages, the `she`
 * MCP source id, `.she/` dirs, `X-SHE-Token`) are intentionally not checked.
 */
import { describe, it, expect, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import { Sidebar } from '../components/Sidebar';
import indexHtml from '../../index.html?raw';
import homeSrc from '../components/Home.tsx?raw';
import terminalSrc from '../components/TerminalPanel.tsx?raw';
import mcpSrc from '../components/McpPanel.tsx?raw';
import appSrc from '../App.tsx?raw';

describe('产品名统一为 Pulse', () => {
  it('浏览器标签页标题是 Pulse', () => {
    expect(indexHtml).toMatch(/<title>Pulse<\/title>/);
    expect(indexHtml).not.toMatch(/<title>bot<\/title>/i);
  });

  it('侧栏 logo 显示 Pulse', () => {
    render(<Sidebar {...({ tree: [], sessions: [], activeSessionId: null, onGroupClick: vi.fn() } as Parameters<typeof Sidebar>[0])} />);
    expect(screen.getByText('Pulse')).toBeTruthy();
    expect(screen.queryByText('bot')).toBeNull();
  });

  it('首页字标、终端横幅、MCP 来源、侧轨标签都叫 Pulse', () => {
    expect(homeSrc).toContain('>Pulse</h1>');
    expect(terminalSrc).toContain("'Pulse 终端");
    expect(terminalSrc).not.toContain('SHE 终端');
    expect(mcpSrc).toContain("s.source === 'she' ? 'Pulse'");
    expect(appSrc).toContain('railLabel}>Pulse<');
  });
});
