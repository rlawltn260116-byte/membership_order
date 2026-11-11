// 확인한 이로움 계산 함수만 네트워크 없는 별도 VM에서 실행한다.
import { createHash } from 'node:crypto';
import vm from 'node:vm';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function calculationSource(source) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.indexOf('function calculate_order_price()');
  const end = source.indexOf('var addr1_timer', start);
  const helper = /function is_part_ca_id\([^)]*\)\s*\{[^}]+\}/.exec(source)?.[0];
  if (start < 0 || end < start || !helper) throw Error('계산 구조 변경');
  return helper.trim() + '\n' + source.slice(start, end).trim();
}

// 실제 사이트에서 읽은 함수의 해시. 변경되면 실행하지 않고 HOLD한다.
const VERIFIED_SOURCE = '27a18dbcb99ebbc8efe4785a1a86d67e2566f83155ac6d5b70876ac810f4b9b1';
const VERIFIED_BOFEEL = '44886b561b9f34178bc9cc96346a6d7635d61df8f7f66a789ba0a0b49fe03e63';
export function bofeelCalculationSource(source) {
  source = source.replace(/\r\n/g, '\n');
  const start = source.indexOf('function gd_set_real_settle_price(');
  const end = source.indexOf('function gd_settlekind_toggle()', start);
  if (start < 0 || end < start) throw Error('계산 구조 변경');
  return source.slice(start, end).trim();
}
export function renderAmount(input) {
  const bofeel = input.vendor === 'bofeel';
  const source = bofeel ? bofeelCalculationSource(input.source) : calculationSource(input.source);
  const fingerprint = bofeel ? source.replace(/\b\d+(?:\.\d+)?\b/g, '0') : source;
  if (createHash('sha256').update(fingerprint).digest('hex') !== (bofeel ? VERIFIED_BOFEEL : VERIFIED_SOURCE)) throw Error('계산 소스 변경');
  const level = bofeel ? '1' : /var\s+mb_level\s*=\s*['"]?(\d+)['"]?\s*;/.exec(input.source)?.[1];
  if (!level) throw Error('회원 가격 분기 미확인');
  const context = vm.createContext(Object.create(null), {
    codeGeneration: { strings: false, wasm: false }, microtaskMode: 'afterEvaluate',
  });
  // 외부 객체·함수·파일·프로세스·HTTP API를 VM에 제공하지 않는다.
  const setup = `
    const input = JSON.parse(${JSON.stringify(JSON.stringify({ fields: input.fields, obj: input.obj ?? {}, quotes: input.quotes ?? {}, level: Number(level) }))});
    const globalFields = input.fields.map(x => [...x]), display = {}, requests = [];
    const rowFields = globalFields.filter(([k]) => k.endsWith('[]'));
    const row = {row:true};
    class Query {
      constructor(kind, key) { this.kind=kind; this.key=key; this.length=kind==='rows'?1:0; }
      each(fn) { if(this.kind==='rows') fn.call(row,0,row); return this; }
      eq() { return new Query('row'); }
      find(selector) { return query(selector, true); }
      val(value) {
        if(this.kind==='empty') return undefined;
        const pairs=this.kind==='fieldrow'?rowFields:globalFields;
        if(value===undefined) return pairs.find(x=>x[0]===this.key)?.[1];
        for(const pair of pairs) if(pair[0]===this.key) pair[1]=String(value);
        return this;
      }
      data() { return undefined; }
      text(value) { if(value===undefined) return display[this.key] ?? ''; display[this.key]=String(value); return this; }
      html(value) { return this.text(value); }
      removeClass() { return this; }
      addClass() { return this; }
      hide() { return this; }
      show() { return this; }
      click() { throw Error('쿠폰 분기 미지원'); }
      change() { throw Error('포인트 분기 미지원'); }
    }
    function query(selector, inRow=false) {
      if(typeof selector!=='string') return selector===row?new Query('row'):selector;
      if(selector==='#so_item_list li') return new Query('rows');
      if(selector.startsWith('select')) return new Query('empty');
      const name=/name=["']?([A-Za-z_][A-Za-z0-9_]*(?:\\[\\])?)/.exec(selector)?.[1];
      if(name) return new Query(inRow?'fieldrow':'field',name);
      return new Query('display',selector);
    }
    const $=query;
    $.ajaxSetup=()=>{};
    $.post=(path,data,callback)=>{
      if(!['./ajax.od_send_cost.php','./ajax.installation_cost.php'].includes(path)) throw Error('계산 외 호출');
      requests.push({path,data});
      const quote=input.quotes[path] ?? 0;
      if(typeof callback==='function') callback(quote);
      return {done(fn){fn(quote);return this;},fail(){return this;}};
    };
    const number_format=String, mb_level=input.level, item_sale_obj={};
    const gd_money_format=String, gd_add_money_format=String;
    const _={isUndefined:x=>x===undefined};
    const numeral=x=>({format:()=>String(x),unformat:y=>Number(String(y).replace(/,/g,''))});
    item_sale_obj[input.obj.it_id]={};
    for(const key of ['it_sale_cnt','it_sale_percent','it_sale_percent_great'])
      item_sale_obj[input.obj.it_id][key]=['','_02','_03','_04','_05'].map(s=>input.obj[key+s]);
    const alert=()=>{throw Error('계산 경고');};
  `;
  vm.runInContext(setup + '\n' + source + (bofeel ? '\ngd_set_real_settle_price();' : '\ncalculate_order_price();'), context, { timeout: 1000 });
  return JSON.parse(vm.runInContext('JSON.stringify({fields:globalFields,display,requests})', context, { timeout: 1000 }));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  let raw = '';
  for await (const chunk of process.stdin) raw += chunk;
  try { process.stdout.write(JSON.stringify(renderAmount(JSON.parse(raw)))); }
  catch { process.stderr.write('금액 화면 계산 대조 실패'); process.exitCode = 1; }
}
