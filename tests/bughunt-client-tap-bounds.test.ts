import { expect, test } from 'vitest';
import { dataBox } from '../src/ink/geometry';
import type { StrokeData } from '../src/lib/types';

test('small pen taps include the rendered minimum radius in their dirty bounds', () => {
  const data: StrokeData = { tool: 'pen', size: 0.5, input: 'pen', color: '#000', device: 'test', t0: 0, pts: [10, 768.6, 0, 0, 0, 0] };
  expect(dataBox(data).minY).toBeCloseTo(767.8, 10);
});
