import { describe, it, expect } from 'vitest';
import { join } from 'node:path';
// @ts-expect-error -- plain .mjs installer helper, deliberately not TypeScript.
import { uicConfigPath } from '../../installer/scripts/lib/uicConfig.mjs';

/**
 * Where setup writes for UIC GPT. The file's contents use Claude Desktop's
 * format and the same merge, which configMerge.test.ts already covers — so the
 * only UIC-specific thing to get right is the path.
 */
describe('uicConfigPath', () => {
  it('is uic_gpt_config.json under APPDATA\\UIC GPT', () => {
    expect(uicConfigPath({ APPDATA: 'C:\\R' })).toBe(join('C:\\R', 'UIC GPT', 'uic_gpt_config.json'));
  });

  it('returns null with nothing to go on', () => {
    expect(uicConfigPath({})).toBeNull();
    expect(uicConfigPath({ APPDATA: '  ' })).toBeNull();
  });
});
