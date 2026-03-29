import { Router, Request, Response } from "express";
import { execFile } from "child_process";
import { createClient } from "redis";

const router: Router = Router();
const DASH_PASSWORD = process.env.DASHBOARD_PASSWORD || "omniforge2026";

function auth(req: Request, res: Response): boolean {
  const token = (req.query.token as string) || (req.headers["x-dashboard-token"] as string);
  if (token !== DASH_PASSWORD) {
    res.status(401).json({ error: "Unauthorized. Add ?token=<password>" });
    return false;
  }
  return true;
}

const loginHtml = `<!DOCTYPE html><html><head><title>OmniForge</title>
<style>body{background:#0d1117;color:#e6edf3;font-family:monospace;display:flex;align-items:center;justify-content:center;height:100vh;margin:0}
.box{background:#161b22;border:1px solid #30363d;padding:2rem;border-radius:8px;text-align:center}
h2{color:#58a6ff}input{background:#0d1117;border:1px solid #30363d;color:#e6edf3;padding:8px;border-radius:4px;width:250px}
button{background:#238636;color:#fff;border:none;padding:8px 16px;border-radius:4px;cursor:pointer;margin-left:8px}</style></head>
<body><div class="box"><h2>OmniForge Dashboard</h2><p>Senha:</p>
<input type="password" id="pw" onkeydown="if(event.key==='Enter')login()">
<button onclick="login()">Entrar</button></div>
<script>function login(){window.location='/dashboard/?token='+document.getElementById('pw').value}</script>
</body></html>`;

const dashHtml = `<!DOCTYPE html><html><head><title>OmniForge Dashboard</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>*{box-sizing:border-box}body{background:#0d1117;color:#e6edf3;font-family:monospace;margin:0;padding:1rem}
h1{color:#58a6ff;font-size:1.1rem;margin:0 0 1rem}
.grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(260px,1fr));gap:1rem;margin-bottom:1rem}
.card{background:#161b22;border:1px solid #30363d;border-radius:8px;padding:1rem}
.card h3{color:#7ee787;margin:0 0 .5rem;font-size:.85rem}
.badge{display:inline-block;padding:2px 8px;border-radius:10px;font-size:.75rem;margin:2px}
.green{background:#1f6822;color:#7ee787}.red{background:#671c1c;color:#f85149}.blue{background:#1f3d7a;color:#58a6ff}.yellow{background:#4d3700;color:#e3b341}
.session{padding:4px 0;border-bottom:1px solid #21262d;font-size:.8rem}
#logs{height:350px;overflow-y:auto;background:#0d1117;padding:.5rem;border-radius:4px;font-size:.72rem;line-height:1.4}</style>
</head><body>
<h1>OmniForge - Clink Code Dashboard</h1>
<div class="grid">
  <div class="card"><h3>Sessoes Ativas</h3><div id="sessions">Carregando...</div></div>
  <div class="card"><h3>Modelos em Uso</h3><div id="models">Carregando...</div></div>
  <div class="card"><h3>Sistema</h3><div id="system">Carregando...</div></div>
</div>
<div class="card"><h3>Logs em Tempo Real <small id="ts" style="color:#8b949e"></small></h3><div id="logs"></div></div>
<script>
const T=new URLSearchParams(location.search).get('token')||'';
async function api(u){const r=await fetch(u+(u.includes('?')?'&':'?')+'token='+T);return r.json();}
async function refresh(){
  try{
    const[s,l]=await Promise.all([api('/dashboard/stats'),api('/dashboard/logs')]);
    document.getElementById('sessions').innerHTML=s.sessions.length
      ?s.sessions.map(x=>'<div class="session"><span class="badge '+(x.active?'green':'red')+'">'+(x.active?'ATIVO':'IDLE')+'</span> <b>'+x.chatId+'</b> - <span class="badge blue">'+x.model+'</span><br><span style="color:#8b949e">'+x.project+'</span></div>').join('')
      :'<span style="color:#8b949e">Sem sessoes</span>';
    document.getElementById('models').innerHTML=Object.keys(s.modelCounts).length
      ?Object.entries(s.modelCounts).map(([m,c])=>'<div><span class="badge blue">'+c+'x</span> '+m+'</div>').join('')
      :'<span style="color:#8b949e">Sem dados</span>';
    document.getElementById('system').innerHTML=
      '<div>Uptime: <span class="badge green">'+s.uptime+'</span></div>'+
      '<div>Provider: <span class="badge blue">'+s.provider+'</span></div>'+
      '<div>Redis: <span class="badge '+(s.redis?'green':'red')+'">'+(s.redis?'OK':'ERRO')+'</span></div>'+
      '<div>Usuarios: <span class="badge yellow">'+s.totalUsers+'</span> Projetos: <span class="badge yellow">'+s.totalProjects+'</span></div>';
    const d=document.getElementById('logs');
    d.innerHTML=l.lines.map(ln=>'<div style="color:'+(ln.includes('ERROR')||ln.includes('error')?'#f85149':ln.includes('warn')?'#e3b341':'#e6edf3')+'">'+ln.replace(/&/g,'&amp;').replace(/</g,'&lt;')+'</div>').join('');
    d.scrollTop=d.scrollHeight;
    document.getElementById('ts').textContent='- '+new Date().toLocaleTimeString();
  }catch(e){console.error(e);}
}
refresh();setInterval(refresh,8000);
</script></body></html>`;

router.get("/", (req: Request, res: Response) => {
  const token = (req.query.token as string) || "";
  if (token !== DASH_PASSWORD) {
    res.send(loginHtml);
    return;
  }
  res.send(dashHtml);
});

router.get("/stats", async (req: Request, res: Response) => {
  if (!auth(req, res)) return;
  let redisOk = false;
  const sessions: any[] = [];
  const modelCounts: Record<string, number> = {};
  let totalProjects = 0, totalUsers = 0;
  try {
    const client = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });
    await client.connect();
    redisOk = true;
    const keys = await client.keys("user_session:*");
    totalUsers = keys.length;
    for (const key of keys.slice(0, 50)) {
      const raw = await client.get(key);
      if (!raw) continue;
      try {
        const s = JSON.parse(raw);
        const chatId = key.replace("user_session:", "");
        const model = s.currentModel || "unknown";
        const active = s.active === true || !!s.sessionId;
        sessions.push({ chatId, model, active, project: s.activeProject || "sem projeto" });
        modelCounts[model] = (modelCounts[model] || 0) + 1;
      } catch { /* skip */ }
    }
    const pk = await client.keys("project:*");
    totalProjects = pk.length;
    await client.disconnect();
  } catch { /* redis unavailable */ }
  const up = process.uptime();
  const uptimeStr = Math.floor(up / 3600) + "h " + Math.floor((up % 3600) / 60) + "m";
  res.json({ sessions, modelCounts, totalProjects, totalUsers, uptime: uptimeStr, provider: process.env.AGENT_PROVIDER || "claude", redis: redisOk });
});

router.get("/logs", (req: Request, res: Response) => {
  if (!auth(req, res)) return;
  execFile("journalctl", ["-u", "clinkcode", "-n", "100", "--no-pager", "--output=short"], (err, stdout) => {
    if (err) { res.json({ lines: ["Erro: " + err.message] }); return; }
    const lines = stdout.split("\n").filter(Boolean).slice(-80);
    res.json({ lines });
  });
});

export { router as dashboardRouter };
