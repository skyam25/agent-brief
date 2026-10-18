import { describe, expect, test } from 'claude-code/testing'

import { itemsFile } from '../hooks/items-file'

describe('itemsFile', () => {
  test('sits under .feedback/items, named for the session', () => {
    expect(itemsFile('/work', 's1')).toBe('/work/.feedback/items/s1.md')
  })
})
