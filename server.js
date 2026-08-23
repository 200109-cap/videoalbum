/**
 * 视频相册 · 云端后端（零依赖，仅用 Node 内置模块）
 * 运行：node server.js   （可选 PORT=8080）
 * 功能：托管前端静态文件 + 提供 /api 接口，实现跨设备云端同步。
 */
const http = require("http");
const fs = require("fs");
const path = require("path");
const url = require("url");

// 静态托管根目录：兼容「整仓库部署」与「仅部署 server 目录」两种结构
const ROOT = (() => {
  const candidates = [path.resolve(__dirname, ".."), __dirname];
  for (const c of candidates) {
    if (fs.existsSync(path.join(c, "index.html"))) return c;
  }
  return candidates[0];
})();
// 数据目录：云平台可挂载持久磁盘并通过 DATA_DIR 指定（否则用本地 server/data）
const DATA = process.env.DATA_DIR || path.join(__dirname, "data");
const FILES = path.join(DATA, "files");
const THUMBS = path.join(DATA, "thumbs");
const META = path.join(DATA, "meta.json");
const PORT = process.env.PORT || 8080;

[DATA, FILES, THUMBS].forEach(d => { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); });

/* ---------- meta 读写（带串行锁，避免并发写坏） ---------- */
let meta = {};
try { meta = JSON.parse(fs.readFileSync(META, "utf8") || "{}"); } catch (e) { meta = {}; }
let metaChain = Promise.resolve();
function persistMeta() {
  metaChain = metaChain.then(() => new Promise(res => {
    fs.writeFile(META, JSON.stringify(meta, null, 2), () => res());
  }));
  return metaChain;
}

function extFromType(t) {
  const m = {
    "video/mp4": "mp4", "video/quicktime": "mov", "video/x-msvideo": "avi",
    "video/webm": "webm", "video/x-matroska": "mkv", "video/3gpp": "3gp",
    "video/x-m4v": "m4v", "video/ogg": "ogv"
  };
  return m[t] || "mp4";
}

function sendJSON(res, code, obj) {
  res.writeHead(code, { "Content-Type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(obj));
}

const MIME = {
  ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css",
  ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json",
  ".png": "image/png", ".jpg": "image/jpeg", ".ico": "image/x-icon"
};

/* ---------- CORS（支持前端填任意跨域服务器地址） ---------- */
function setCORS(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, PUT, POST, DELETE, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Range");
}

/* ---------- 静态文件托管（非 /api） ---------- */
function serveStatic(req, res, pathname) {
  let rel = decodeURIComponent(pathname);
  if (rel === "/") rel = "/index.html";
  const fp = path.join(ROOT, rel);
  if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end("forbidden"); return; }
  fs.stat(fp, (err, st) => {
    if (err || !st.isFile()) { res.writeHead(404); res.end("not found"); return; }
    const ext = path.extname(fp).toLowerCase();
    res.writeHead(200, { "Content-Type": MIME[ext] || "application/octet-stream", "Cache-Control": "no-cache" });
    fs.createReadStream(fp).pipe(res);
  });
}

/* ---------- API ---------- */
function handleApi(req, res, u) {
  const p = u.pathname;
  const q = u.query;

  if (p === "/api/health" && req.method === "GET") return sendJSON(res, 200, { ok: true });

  if (p === "/api/videos" && req.method === "GET") {
    const list = Object.values(meta).sort((a, b) => b.createdAt - a.createdAt);
    return sendJSON(res, 200, list);
  }

  if (p === "/api/storage" && req.method === "GET") {
    let usedBytes = 0, count = 0;
    for (const k in meta) { usedBytes += (meta[k].size || 0); count++; }
    // 估算缩略图占用
    try {
      for (const f of fs.readdirSync(THUMBS)) {
        const s = fs.statSync(path.join(THUMBS, f));
        if (s.isFile()) usedBytes += s.size;
      }
    } catch (e) {}
    return sendJSON(res, 200, { usedBytes, count });
  }

  let m;
  // /api/video/:id
  if ((m = p.match(/^\/api\/video\/([\w.-]+)$/))) {
    const id = m[1];
    const rec = meta[id];

    if (req.method === "PUT") {
      const ext = extFromType(q.type || "video/mp4");
      const fp = path.join(FILES, id + "." + ext);
      const ws = fs.createWriteStream(fp);
      req.pipe(ws);
      ws.on("finish", () => {
        const size = parseInt(q.size || "0", 10) || (fs.existsSync(fp) ? fs.statSync(fp).size : 0);
        meta[id] = {
          id,
          name: q.name || (id + "." + ext),
          type: q.type || "video/mp4",
          duration: parseFloat(q.duration || "0") || 0,
          size,
          createdAt: Date.now()
        };
        persistMeta().then(() => sendJSON(res, 200, { ok: true, id }));
      });
      ws.on("error", () => { res.writeHead(500); res.end("write error"); });
      return;
    }

    if (req.method === "DELETE") {
      if (rec) {
        const ext = extFromType(rec.type);
        [path.join(FILES, id + "." + ext), path.join(THUMBS, id + ".jpg")].forEach(f => {
          try { fs.unlinkSync(f); } catch (e) {}
        });
        delete meta[id];
        persistMeta();
      }
      return sendJSON(res, 200, { ok: true });
    }

    if (req.method === "GET") {
      if (!rec) { res.writeHead(404); res.end("not found"); return; }
      const ext = extFromType(rec.type);
      const fp = path.join(FILES, id + "." + ext);
      fs.stat(fp, (err, st) => {
        if (err) { res.writeHead(404); res.end("not found"); return; }
        const total = st.size;
        const range = req.headers.range;
        if (range) {
          const mm = range.match(/bytes=(\d+)-(\d*)/);
          let start = parseInt(mm[1], 10);
          let end = mm[2] ? parseInt(mm[2], 10) : total - 1;
          if (isNaN(start) || start > end || start >= total) {
            res.writeHead(416, { "Content-Range": "bytes */" + total }); res.end(); return;
          }
          end = Math.min(end, total - 1);
          res.writeHead(206, {
            "Content-Type": rec.type,
            "Content-Range": "bytes " + start + "-" + end + "/" + total,
            "Accept-Ranges": "bytes", "Content-Length": (end - start + 1), "Cache-Control": "no-cache"
          });
          fs.createReadStream(fp, { start, end }).pipe(res);
        } else {
          res.writeHead(200, {
            "Content-Type": rec.type, "Accept-Ranges": "bytes",
            "Content-Length": total, "Cache-Control": "no-cache"
          });
          fs.createReadStream(fp).pipe(res);
        }
      });
      return;
    }
  }

  // /api/thumb/:id
  if ((m = p.match(/^\/api\/thumb\/([\w.-]+)$/))) {
    const id = m[1];
    const fp = path.join(THUMBS, id + ".jpg");
    if (req.method === "PUT") {
      const ws = fs.createWriteStream(fp);
      req.pipe(ws);
      ws.on("finish", () => sendJSON(res, 200, { ok: true }));
      ws.on("error", () => { res.writeHead(500); res.end("err"); });
      return;
    }
    if (req.method === "GET") {
      fs.stat(fp, err => {
        if (err) { res.writeHead(404); res.end("none"); return; }
        res.writeHead(200, { "Content-Type": "image/jpeg", "Cache-Control": "no-cache" });
        fs.createReadStream(fp).pipe(res);
      });
      return;
    }
  }

  res.writeHead(404); res.end("api not found");
}

/* ---------- 启动 ---------- */
const server = http.createServer((req, res) => {
  setCORS(res);
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }
  const u = url.parse(req.url, true);
  if (u.pathname.startsWith("/api/")) return handleApi(req, res, u);
  return serveStatic(req, res, u.pathname);
});

server.listen(PORT, () => {
  console.log("视频相册云端服务已启动: http://localhost:" + PORT);
  console.log("数据目录: " + DATA);
});
