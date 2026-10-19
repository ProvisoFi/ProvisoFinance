import http from "node:http";
import path from "node:path";
import { createReadStream, statSync } from "node:fs";
const root = path.resolve("out");
const port = Number(process.env.PORT || 4173);
const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".png": "image/png",
  ".webp": "image/webp",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".mp4": "video/mp4",
  ".pdf": "application/pdf",
  ".xml": "application/xml",
};
const server = http.createServer((req, res) => {
  if (!["GET", "HEAD"].includes(req.method)) {
    res.writeHead(405, { Allow: "GET, HEAD" });
    return res.end();
  }
  let pathname;
  try {
    pathname = decodeURIComponent(
      new URL(req.url, "http://localhost").pathname,
    );
  } catch {
    res.writeHead(400);
    return res.end("Invalid request");
  }
  let file = path.resolve(root, "." + pathname);
  if (!file.startsWith(root + path.sep) && file !== root) {
    res.writeHead(403);
    return res.end();
  }
  let status = 200,
    stat;
  try {
    stat = statSync(file);
    if (stat.isDirectory()) {
      file = path.join(file, "index.html");
      stat = statSync(file);
    }
  } catch {
    status = 404;
    file = path.join(root, "404.html");
    try {
      stat = statSync(file);
    } catch {
      res.writeHead(404);
      return res.end("Build the site first with npm run build.");
    }
  }
  if (!stat.isFile()) {
    res.writeHead(404);
    return res.end();
  }
  const headers = {
    "Content-Type": mime[path.extname(file)] || "application/octet-stream",
    "Cache-Control": "no-cache",
    "X-Content-Type-Options": "nosniff",
    "Accept-Ranges": "bytes",
  };
  let start = 0,
    end = stat.size - 1;
  if (req.headers.range && status === 200) {
    const match = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range);
    if (!match || (!match[1] && !match[2])) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    if (!match[1]) start = Math.max(0, stat.size - Number(match[2]));
    else {
      start = Number(match[1]);
      if (match[2]) end = Math.min(end, Number(match[2]));
    }
    if (start > end || start >= stat.size) {
      res.writeHead(416, { "Content-Range": `bytes */${stat.size}` });
      return res.end();
    }
    status = 206;
    headers["Content-Range"] = `bytes ${start}-${end}/${stat.size}`;
  }
  headers["Content-Length"] = end - start + 1;
  res.writeHead(status, headers);
  if (req.method === "HEAD") return res.end();
  createReadStream(file, { start, end })
    .on("error", () => res.destroy())
    .pipe(res);
});
server.listen(port, "127.0.0.1", () =>
  console.log(`Proviso preview: http://127.0.0.1:${port}`),
);
