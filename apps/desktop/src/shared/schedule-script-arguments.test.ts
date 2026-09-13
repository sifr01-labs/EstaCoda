import {it,expect} from 'vitest';
import {formatScheduleArguments,parseScheduleArguments} from './schedule-script-arguments.js';
it('distinguishes clearing all arguments from intentionally empty arguments',()=>{
 expect(parseScheduleArguments('')).toEqual([]);expect(parseScheduleArguments('""')).toEqual(['']);
 for(const args of [[],[''],['--format','Arabic report'],[' leading space ', '', 'trailing'],['"literal quotes"','line\nbreak','carriage\rreturn','عربي /path']])expect(parseScheduleArguments(formatScheduleArguments(args))).toEqual(args);
 expect(()=>parseScheduleArguments('"unterminated')).toThrow();
});
