/** One argument per line; a quoted JSON string preserves empty or multiline arguments. */
export function formatScheduleArguments(args:readonly string[]):string {
 return args.map(arg=>arg===''||arg.startsWith('"')||/[\r\n]/.test(arg)?JSON.stringify(arg):arg).join('\n');
}
export function parseScheduleArguments(text:string):string[] {
 if(text==='')return [];
 return text.split('\n').map(line=>{
  if(!line.startsWith('"'))return line;
  const value:unknown=JSON.parse(line);
  if(typeof value!=='string')throw new Error('Expected a string argument.');
  return value;
 });
}
