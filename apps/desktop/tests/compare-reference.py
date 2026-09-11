from pathlib import Path
from PIL import Image,ImageChops,ImageDraw
import json
root=Path('apps/desktop/tests/visual-evidence'); report=[]
for ref in sorted(root.glob('*-reference.png')):
 name=ref.name.removesuffix('-reference.png'); current=root/(name+'-react.png')
 if not current.exists():continue
 a=Image.open(ref).convert('RGB');b=Image.open(current).convert('RGB');size=(max(a.width,b.width),max(a.height,b.height));ac=Image.new('RGB',size,'magenta');bc=ac.copy();ac.paste(a,(0,0));bc.paste(b,(0,0));delta=ImageChops.difference(ac,bc);changed=sum(max(x)>24 for x in delta.getdata());report.append({'id':name,'referenceSize':a.size,'reactSize':b.size,'changedPixelsOver24':changed,'ratio':changed/(size[0]*size[1])});Image.blend(ac,bc,.5).save(root/(name+'-overlay.png'))
(root/'differences.json').write_text(json.dumps(report,indent=2));print('\n'.join(f"{r['ratio']:.3%} {r['id']} {r['referenceSize']} {r['reactSize']}" for r in sorted(report,key=lambda x:x['ratio'],reverse=True)[:25]))
