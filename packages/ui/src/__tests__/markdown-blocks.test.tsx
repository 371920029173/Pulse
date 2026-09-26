import { describe, it, expect } from 'vitest';
import { render } from '@testing-library/react';
import { Markdown } from '../components/Markdown';

describe('Markdown block syntax', () => {
  it('renders a GFM table instead of a line of pipes', () => {
    const md = 'intro\n\n| a | b |\n|---|---:|\n| 1 | `x|y` |\n| 2 | **3** |\n\nafter';
    const { container } = render(<Markdown text={md} />);
    const table = container.querySelector('table')!;
    expect(table).toBeTruthy();
    expect(table.querySelectorAll('th').length).toBe(2);
    expect(table.querySelectorAll('tbody tr').length).toBe(2);
    expect(table.querySelector('tbody tr td:nth-child(2) code')!.textContent).toBe('x|y');
    expect((table.querySelector('th:nth-child(2)') as HTMLElement).style.textAlign).toBe('right');
    expect(container.textContent).not.toContain('|---');
  });

  it('does not swallow a table that directly follows a paragraph line', () => {
    const { container } = render(<Markdown text={'score below\n| k | v |\n|---|---|\n| a | b |'} />);
    expect(container.querySelector('table')).toBeTruthy();
    expect(container.querySelector('p')!.textContent).toBe('score below');
  });

  it('renders ordered lists, keeping the start number', () => {
    const { container } = render(<Markdown text={'high\n1. first\n2. second\n\n3. third'} />);
    const ols = container.querySelectorAll('ol');
    expect(ols.length).toBe(2);
    expect(ols[0].querySelectorAll('li').length).toBe(2);
    expect(ols[1].getAttribute('start')).toBe('3');
  });

  it('renders rules, quotes and h4', () => {
    const { container } = render(<Markdown text={'#### small\n\n---\n\n> quoted **bold**'} />);
    expect(container.querySelector('h4')!.textContent).toBe('small');
    expect(container.querySelector('hr')).toBeTruthy();
    expect(container.querySelector('blockquote strong')!.textContent).toBe('bold');
  });
});
