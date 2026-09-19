import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { outlineFile } from '../outline.js';

describe('outline AST', () => {
  it('finds class methods via typescript AST', () => {
    const src = `
export class Foo {
  bar() { return 1; }
  async baz() { return 2; }
}
export function top() {}
export const arrow = () => 3;
export interface IFace { x: number }
`;
    const syms = outlineFile('x.ts', 'x.ts', src);
    const names = syms.map((s) => s.name);
    assert.ok(names.includes('Foo'));
    assert.ok(names.includes('bar'));
    assert.ok(names.includes('baz'));
    assert.ok(names.includes('top'));
    assert.ok(names.includes('arrow'));
    assert.ok(names.includes('IFace'));
    const bar = syms.find((s) => s.name === 'bar');
    assert.equal(bar?.kind, 'method');
    assert.ok((bar?.depth ?? 0) >= 1);
  });
});
