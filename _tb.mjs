import { chromium } from 'playwright';
const b=await chromium.launch({executablePath:'/opt/pw-browsers/chromium-1194/chrome-linux/chrome'});
const p=await b.newPage(); const errs=[]; p.on('pageerror',e=>errs.push(e.message));
const dlg=[]; p.on('dialog',async d=>{dlg.push(d.message());await d.accept();});

// 模擬：共用庫已有「Kai」建立的商品
const store={ 'K00100':{code:'K00100',data:{code:'K00100',name:'Kai的商品',vendor:'廠商A',variants:[{idx:1,style:'紅',size:'M',wholesale:'50',vendorCode:'V9',weight:'0.5'}]},updatedAt:'2026-08-01T00:00:00.000Z',updatedBy:'Kai'} };
let list=[{code:'K00100',name:'Kai的商品',updatedAt:'2026-08-01T00:00:00.000Z',updatedBy:'Kai'}];
await p.route('**/didibox-api*/api/products**', async route=>{
  const r=route.request(), u=new URL(r.url()), m=r.method();
  const J=(s,o)=>route.fulfill({status:s,contentType:'application/json',headers:{'Access-Control-Allow-Origin':'*'},body:JSON.stringify(o)});
  if (r.headers()['x-quote-token']!=='pw') return J(401,{error:'未授權'});
  const code=u.pathname.replace('/api/products','').replace(/^\//,'');
  if (m==='GET'&&!code) return J(200,{role:'user',list});
  if (m==='GET') return store[code]?J(200,store[code]):J(404,{error:'找不到'});
  if (m==='PUT'){ const bd=JSON.parse(r.postData()); const ex=store[code];
    if (ex&&!bd.force&&(bd.baseUpdatedAt||'')!==(ex.updatedAt||'')) return J(409,{error:'conflict',serverUpdatedAt:ex.updatedAt,serverUpdatedBy:ex.updatedBy});
    const now=new Date().toISOString(); store[code]={code,data:bd.data,updatedAt:now,updatedBy:bd.updatedBy};
    list=list.filter(x=>x.code!==code); list.unshift({code,name:bd.data.name,updatedAt:now,updatedBy:bd.updatedBy}); return J(200,{ok:true,updatedAt:now}); }
  return J(405,{});
});

await p.goto('file:///home/user/r2-link-generator/index.html'); await p.waitForTimeout(700);
await p.evaluate(()=>switchTab('product'));
await p.fill('#sharePassword','pw'); await p.fill('#shareUser','Allen');
await p.click('button:has-text("連線")'); await p.waitForTimeout(500);
console.log('狀態:', await p.textContent('#shareStatus'));
console.log('共用清單:', await p.evaluate(()=>[...document.querySelectorAll('#sharedProductList button')].map(b=>b.textContent.trim().replace(/\s+/g,' '))));

// 載入 Kai 的商品
dlg.length=0;
await p.click('#sharedProductList button'); await p.waitForTimeout(500);
console.log('\n載入後表單:', await p.evaluate(()=>({code:document.getElementById('p_code').value,name:document.getElementById('p_name').value,規格數:document.querySelectorAll('#variantRows tr').length})));
console.log('loadedBaseUpdatedAt:', await p.evaluate(()=>loadedBaseUpdatedAt));

// 編輯後儲存
await p.fill('#p_name','Allen改過的名字');
dlg.length=0;
await p.click('button:has-text("💾 儲存")'); await p.waitForTimeout(800);
console.log('\n儲存狀態:', await p.textContent('#saveStatus'));
console.log('對話框:', dlg.length?dlg.map(d=>d.slice(0,60)):'無');
console.log('伺服器現況:', store['K00100'].data.name, '| by', store['K00100'].updatedBy);
console.log('\nJS錯誤:', errs.length?errs:'無');
await b.close();
