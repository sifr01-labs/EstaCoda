export function compactNumber(value:number,locale='en'):string{
 return new Intl.NumberFormat(locale,{notation:'compact',maximumFractionDigits:2}).format(value);
}
export function compactCost(value:number,locale='en',currency='USD'):string{
 const format=(amount:number)=>new Intl.NumberFormat(locale,{style:'currency',currency,minimumFractionDigits:amount>0&&amount<1?3:2,maximumFractionDigits:amount>0&&amount<1?3:2}).format(amount);
 try{return value>0&&value<0.001?'<'+format(0.001):format(value);}catch{return new Intl.NumberFormat(locale,{maximumFractionDigits:6}).format(value)+' '+currency;}
}
export function contextPercent(used:number,total:number,locale='en'):string{
 const ratio=total>0?used/total:0;
 const format=(n:number)=>new Intl.NumberFormat(locale,{style:'percent',maximumFractionDigits:0}).format(n);
 return ratio>0&&ratio<0.01?'<'+format(0.01):format(ratio);
}
