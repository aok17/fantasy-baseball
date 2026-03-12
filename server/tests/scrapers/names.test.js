import { describe, it, expect } from 'vitest';
import { convertLastFirst, reconcileName } from '../../src/scrapers/names.js';

describe('convertLastFirst', () => {
  it('converts "Last, First" to "First Last"', () => {
    expect(convertLastFirst('Verlander, Justin')).toBe('Justin Verlander');
  });
  it('returns unchanged if no comma', () => {
    expect(convertLastFirst('Justin Verlander')).toBe('Justin Verlander');
  });
});

describe('reconcileName', () => {
  const replacements = { 'Pete Alonso': 'Peter Alonso', 'Jake Faria': 'Jacob Faria' };
  it('returns canonical name when alt exists', () => {
    expect(reconcileName('Pete Alonso', replacements)).toBe('Peter Alonso');
  });
  it('returns original name when no replacement exists', () => {
    expect(reconcileName('Mike Trout', replacements)).toBe('Mike Trout');
  });
});
