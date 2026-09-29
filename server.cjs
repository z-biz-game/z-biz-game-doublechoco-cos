// Zero-dependency static server. CommonJS on purpose: package.json is "type": "module"
// so `node --check` parses the browser sources as ES modules, and this file still has to be
// requirable by tools/verify.sh.
//
// It answers BOTH URL shapes the repo can be reached at, because Pages serves us under
// /z-biz-game-doublechoco-cos/ while a local run serves at the root. One server answering both means
// the gate's prefix shape is a real second shape, not a second server written just for the test.
const http = require('http');
const fs = require('fs');
const path = require('path');

const PREFIX = '/z-biz-game-doublechoco-cos';

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.cjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.md': 'text/markdown; charset=utf-8',
};

function resolveFile(root, urlPath) {
  let p = path.normalize(urlPath).replace(/^(\.\.[/\\])+/, '');
  // 前缀形态：/z-biz-game-doublechoco-cos/js/main.js 与 /js/main.js 指的是同一个字节。
  if (p === PREFIX || p.startsWith(PREFIX + path.sep)) p = p.slice(PREFIX.length) || '/';
  if (p === '' || p === '/' || p === path.sep) p = '/index.html';
  const file = path.join(root, p);
  return file.startsWith(root) ? file : null;
}

function createServer(root = __dirname) {
  return http.createServer((req, res) => {
    let urlPath;
    try {
      urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }
    const file = resolveFile(root, urlPath);
    if (!file) {
      res.writeHead(403).end('forbidden');
      return;
    }
    fs.stat(file, (err, st) => {
      if (err || !st.isFile()) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' }).end('404');
        return;
      }
      res.writeHead(200, {
        'Content-Type': TYPES[path.extname(file).toLowerCase()] || 'application/octet-stream',
        'Cache-Control': 'no-cache',
      });
      fs.createReadStream(file).pipe(res);
    });
  });
}

function startServer({ port = 5263, root = __dirname } = {}) {
  return new Promise((resolve, reject) => {
    const server = createServer(root);
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

module.exports = { createServer, startServer, resolveFile, PREFIX };

if (require.main === module) {
  const port = Number(process.argv[2]) || Number(process.env.PORT) || 5263;
  startServer({ port })
    .then((server) => {
      console.log(`DOUBLE CHOCO / ダブルチョコ 双巧克力方块 served at http://127.0.0.1:${port}/  and  http://127.0.0.1:${port}${PREFIX}/  (ctrl+c to stop)`);
      process.on('SIGINT', () => server.close(() => process.exit(0)));
    })
    .catch((err) => {
      console.error('failed to start:', err.message);
      process.exit(1);
    });
}
