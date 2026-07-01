import { createServer, IncomingMessage, ServerResponse } from 'http';
import { readFileSync, existsSync } from 'fs';
import { resolve } from 'path';
import { queryPayment, getDb, closeDb } from './db';
import { syncFromSheet2ToDb } from './popo-sync';
import { runImport } from './import-mapping';

interface EpcConfig {
  server: { port: number; host: string };
}

function loadServerConfig(): { port: number; host: string } {
  const configPath = resolve(__dirname, '..', 'config', 'epc.json');
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as EpcConfig;
  return raw.server;
}

function sendJson(res: ServerResponse, data: unknown, statusCode = 200): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data, null, 2));
}

function parseBody(req: IncomingMessage): Promise<Record<string, string>> {
  return new Promise((resolve) => {
    let body = '';
    req.on('data', (chunk: Buffer) => (body += chunk.toString()));
    req.on('end', () => {
      try { resolve(JSON.parse(body)); } catch {
        const params = new URLSearchParams(body);
        const result: Record<string, string> = {};
        for (const [k, v] of params) result[k] = v;
        resolve(result);
      }
    });
  });
}

function parseQuery(url: string): Record<string, string> {
  const idx = url.indexOf('?');
  if (idx === -1) return {};
  const params = new URLSearchParams(url.slice(idx));
  const result: Record<string, string> = {};
  for (const [k, v] of params) result[k] = v;
  return result;
}

function getQueryPage(): string {
  const pagePath = resolve(__dirname, 'query-page.html');
  if (existsSync(pagePath)) return readFileSync(pagePath, 'utf-8');
  return generateQueryPage();
}

function generateQueryPage(): string {
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>公账到账查询</title>
<style>
*{margin:0;padding:0;box-sizing:border-box}
body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI','Microsoft YaHei',sans-serif;background:#f5f5f5;min-height:100vh;padding:20px}
.container{width:100%;max-width:460px;margin:30px auto}
.card{background:#fff;border-radius:12px;padding:32px 24px;box-shadow:0 2px 12px rgba(0,0,0,.08)}
h1{font-size:22px;text-align:center;margin-bottom:6px;color:#1a1a1a}
.subtitle{font-size:13px;color:#999;text-align:center;margin-bottom:28px}
.form-group{margin-bottom:18px}
.form-group label{display:block;font-size:14px;color:#333;margin-bottom:6px;font-weight:500}
.form-group input{width:100%;height:44px;padding:0 14px;border:1px solid #dcdcdc;border-radius:8px;font-size:15px;outline:none;transition:border-color .2s}
.form-group input:focus{border-color:#1677ff;box-shadow:0 0 0 2px rgba(22,119,255,.1)}
.btn{width:100%;height:46px;background:#1677ff;color:#fff;border:none;border-radius:8px;font-size:16px;font-weight:500;cursor:pointer;transition:background .2s}
.btn:hover{background:#4096ff}
.btn:disabled{background:#a0c4ff;cursor:not-allowed}
.result{margin-top:24px;display:none}
.result.show{display:block}
.result-card{border-radius:10px;padding:20px}
.result-card.paid{border:1px solid #b7eb8f;background:#f6ffed}
.result-card.pending{border:1px solid #ffe58f;background:#fffbe6}
.result-card.error{border:1px solid #ffccc7;background:#fff2f0}
.result-status{font-size:22px;margin-bottom:12px}
.result-detail{font-size:14px;color:#555;line-height:2}
.result-detail .amount{color:#cf1322;font-size:18px;font-weight:600}
.loading{text-align:center;padding:20px;color:#999;display:none}
.loading.show{display:block}
</style>
</head>
<body>
<div class="container">
  <div class="card">
    <h1>公账到账查询</h1>
    <p class="subtitle">输入单号查询付款进度</p>
    <form id="queryForm">
      <div class="form-group">
        <label>单号</label>
        <input type="text" id="orderNo" placeholder="输入你的单号" required autocomplete="off">
      </div>
      <button type="submit" class="btn" id="submitBtn">查询</button>
    </form>
    <div class="loading" id="loading">查询中...</div>
    <div class="result" id="result"></div>
  </div>
</div>
<script>
document.getElementById('queryForm').addEventListener('submit',async function(e){
e.preventDefault();
var o=document.getElementById('orderNo').value.trim();
if(!o)return;
var b=document.getElementById('submitBtn'),l=document.getElementById('loading'),r=document.getElementById('result');
b.disabled=true;l.className='loading show';r.className='result';
try{
  var resp=await fetch('/api/query',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({orderNo:o})});
  var d=await resp.json();
  render(d);
}catch(e){r.innerHTML='<div class="result-card error"><div class="result-status">网络错误</div></div>';r.className='result show'}
finally{b.disabled=false;l.className='loading'}
});

function render(d){
var r=document.getElementById('result');
if(!d.found){
  r.innerHTML='<div class="result-card error"><div class="result-status">未查询到记录</div><div class="result-detail">请确认单号是否正确</div></div>';
  r.className='result show';return;
}
var p=d.payment,paid=p.paid,cardClass=paid?'paid':'pending',
    icon=paid?'已到账':'处理中',
    h='<div class="result-card '+cardClass+'">';
h+='<div class="result-status">'+icon+'</div><div class="result-details">';
if(p.amount!==null)h+='<div>申请金额：<span class="amount">'+fmt(p.amount)+'</span></div>';
if(p.actual_amount!==null)h+='<div>实收金额：<span class="amount">'+fmt(p.actual_amount)+'</span></div>';
h+='<div>当前节点：'+esc(p.status_node||p.status_text||'-')+'</div>';
if(p.paid_time)h+='<div>到账时间：'+esc(p.paid_time)+'</div>';
if(p.updated_at)h+='<div style="font-size:12px;color:#aaa">更新时间：'+esc(p.updated_at)+'</div>';
h+='</div></div>';
r.innerHTML=h;r.className='result show';
}
function esc(s){return s?String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'):''}
function fmt(v){var n=Number(v);return isNaN(n)?v:'&yen;'+n.toLocaleString('zh-CN',{minimumFractionDigits:2,maximumFractionDigits:2})}
</script>
</body>
</html>`;
}

async function handleApiQuery(req: IncomingMessage, res: ServerResponse): Promise<void> {
  let params: Record<string, string>;
  if (req.method === 'POST') {
    params = await parseBody(req);
  } else {
    params = parseQuery(req.url || '');
  }

  const orderNo = (params.orderNo || '').trim();

  if (!orderNo) {
    sendJson(res, { error: '缺少单号', found: false }, 400);
    return;
  }

  const result = queryPayment(orderNo);
  sendJson(res, result);
}

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url || '/';
  if (url.startsWith('/api/query')) {
    return handleApiQuery(req, res);
  }
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(getQueryPage());
}

export async function startServer(port?: number, host?: string): Promise<void> {
  const config = loadServerConfig();
  const listenPort = port || config.port;
  const listenHost = host || config.host;

  try {
    await runImport();
    syncFromSheet2ToDb();
  } catch (err: any) {
    console.log(`同步跳过: ${err.message}`);
  }

  const server = createServer((req, res) => {
    handleRequest(req, res).catch((err) => {
      console.error('请求错误:', err.message);
      res.writeHead(500);
      res.end('Internal Server Error');
    });
  });

  server.listen(listenPort, listenHost, () => {
    const addr = listenHost === '0.0.0.0' ? 'localhost' : listenHost;
    console.log(`查询服务: http://${addr}:${listenPort}`);
  });

  process.on('SIGINT', () => { server.close(); closeDb(); process.exit(0); });
}

if (require.main === module) {
  startServer();
}
