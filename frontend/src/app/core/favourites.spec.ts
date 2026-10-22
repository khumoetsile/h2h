import { describe, expect, it } from 'vitest';
import { readFavourites } from './favourites';

describe('favourite storage recovery', () => {
  it('recovers from invalid or unavailable stored data', () => {
    for (const raw of [null, '{', '{}', 'null', '[null,42]']) expect(readFavourites(raw)).toEqual([]);
  });
  it('retains only valid team and league identities and bounds stored preferences', () => {
    const valid = {kind:'team', id:3, name:'Liverpool'};
    expect(readFavourites(JSON.stringify([valid, {kind:'competition',id:4,name:'League'}, {kind:'team',id:-2,name:'Bad'}, {kind:'user',id:1,name:'Bad'}]))).toEqual([valid, {kind:'competition',id:4,name:'League'}]);
    expect(readFavourites(JSON.stringify(Array(50).fill(valid)))).toHaveLength(30);
  });
});
