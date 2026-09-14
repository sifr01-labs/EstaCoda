import {describe,it,expect} from 'vitest';
import {compactNumber,compactCost,contextPercent} from './usage-format.js';
describe('compact usage preserves useful magnitude and small nonzero amounts',()=>{
 it('shows concise context without concealing near-empty usage',()=>{
  expect(compactNumber(8202)).toBe('8.2K');expect(compactNumber(1048576)).toBe('1.05M');
  expect(contextPercent(8202,1048576)).toBe('<1%');expect(contextPercent(0,100)).toBe('0%');
  expect(contextPercent(500,1000)).toBe('50%');expect(contextPercent(1100,1000)).toBe('110%');
 });
 it('retains nonzero cost instead of rounding it to free',()=>{
  expect(compactCost(0.0542)).toBe('$0.054');expect(compactCost(0.00001)).toBe('<$0.001');
  expect(compactCost(0.0542,'en','EUR')).toContain('0.054');expect(compactCost(0.0542,'en','EUR')).not.toContain('$');expect(compactCost(2,'en','credits')).toBe('2 credits');
  expect(compactCost(0)).toBe('$0.00');expect(compactCost(3.1415)).toBe('$3.14');
 });
 it('uses the chosen locale for numeric formatting',()=>{
  expect(compactNumber(8202,'ar')).toMatch(/[\u0621-\u064a]/);
  expect(contextPercent(1,10000,'ar')).toContain('<');
  expect(compactCost(0.0542,'ar-u-nu-arab')).toMatch(/[\u0660-\u0669]/);
 });
});
