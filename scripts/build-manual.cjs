// The user manual (WP 6.6): docs/manual/<lang>.md and its screenshots become one page per language
// at apps/web/public/manual/<lang>/index.html, which the web app, the desktop app and the server
// bundle all serve (Help ▸ User manual). It runs before each web build.
//
// The Markdown is the plain subset the manual uses: headings, paragraphs, lists, tables, images,
// notes ("> "), **bold**, `code`, links and <kbd>. {{app}} is the app's name in that language,
// from the interface strings, so a rename reaches the manual too.
const fs = require("node:fs");
const path = require("node:path");

const ROOT = path.resolve(__dirname, "..");
const SRC = path.join(ROOT, "docs/manual");
const OUT = path.join(ROOT, "apps/web/public/manual");

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

/** Inline: code first (its text is literal), then <kbd>, bold, links. */
function inline(s) {
  const parts = s.split(/(`[^`]+`)/);
  return parts
    .map((p) => {
      if (/^`[^`]+`$/.test(p)) return `<code>${esc(p.slice(1, -1))}</code>`;
      return esc(p)
        .replace(/&lt;kbd&gt;(.*?)&lt;\/kbd&gt;/g, "<kbd>$1</kbd>")
        .replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>")
        .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => `<a href="${u}"${/^https?:/.test(u) ? ' target="_blank" rel="noopener"' : ""}>${t}</a>`);
    })
    .join("");
}

const slug = (s, used) => {
  let base = s
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "") || "section";
  let id = base;
  for (let i = 2; used.has(id); i++) id = `${base}-${i}`;
  used.add(id);
  return id;
};

/** Markdown to HTML, and the table of contents (level-2 headings). */
function render(md, lang) {
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  const toc = [];
  const used = new Set();
  let i = 0;
  const para = [];
  const flush = () => {
    if (para.length) out.push(`<p>${inline(para.join(" "))}</p>`);
    para.length = 0;
  };
  while (i < lines.length) {
    const l = lines[i];
    let m;
    if (!l.trim()) {
      flush();
      i++;
    } else if ((m = l.match(/^(#{1,4})\s+(.*)$/))) {
      flush();
      const n = m[1].length;
      const id = slug(m[2], used);
      if (n === 2) toc.push([id, m[2]]);
      out.push(`<h${n} id="${id}">${inline(m[2])}</h${n}>`);
      i++;
    } else if ((m = l.match(/^!\[([^\]]*)\]\(([^)]+)\)$/))) {
      flush();
      const src = m[2];
      // The size from the PNG's header, so the page keeps its place while images load.
      let size = "";
      try {
        const b = fs.readFileSync(path.join(SRC, src.replace(/^img\//, `img/${lang}/`)));
        size = ` width="${b.readUInt32BE(16)}" height="${b.readUInt32BE(20)}"`;
      } catch {
        /* no image yet: the page still builds */
      }
      out.push(`<figure><img src="${esc(src)}" alt="${esc(m[1])}"${size} loading="lazy"><figcaption>${inline(m[1])}</figcaption></figure>`);
      i++;
    } else if (/^>\s?/.test(l)) {
      flush();
      const q = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) q.push(lines[i++].replace(/^>\s?/, ""));
      out.push(`<aside class="note">${inline(q.join(" "))}</aside>`);
    } else if (/^\|/.test(l)) {
      flush();
      const rows = [];
      while (i < lines.length && /^\|/.test(lines[i])) rows.push(lines[i++]);
      const cells = (r) => r.replace(/^\||\|$/g, "").split("|").map((c) => c.trim());
      const head = cells(rows[0]);
      const body = rows.slice(/^\|[\s:|-]+\|$/.test(rows[1] ?? "") ? 2 : 1).map(cells);
      out.push(`<div class="table"><table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join("")}</tr></thead><tbody>${body.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`);
    } else if (/^(\s*)([-*]|\d+\.)\s+/.test(l)) {
      flush();
      const ordered = /^\s*\d+\./.test(l);
      const items = [];
      while (i < lines.length && (/^\s*([-*]|\d+\.)\s+/.test(lines[i]) || (/^\s{2,}\S/.test(lines[i]) && items.length))) {
        if (/^\s*([-*]|\d+\.)\s+/.test(lines[i])) items.push(lines[i].replace(/^\s*([-*]|\d+\.)\s+/, ""));
        else items[items.length - 1] += ` ${lines[i].trim()}`;
        i++;
      }
      const tag = ordered ? "ol" : "ul";
      out.push(`<${tag}>${items.map((t) => `<li>${inline(t)}</li>`).join("")}</${tag}>`);
    } else {
      para.push(l.trim());
      i++;
    }
  }
  flush();
  return { body: out.join("\n"), toc };
}

const CSS = `
:root{--bg:#f6f7f9;--fg:#15181d;--fg2:#4a515c;--line:#dde1e7;--card:#fff;--accent:#2563c9;--note:#eef3fc;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme=light]){--bg:#0f1115;--fg:#e8eaee;--fg2:#a3abb7;--line:#2a2f38;--card:#171a20;--accent:#7aa7f0;--note:#18233a;color-scheme:dark}}
:root[data-theme=dark]{--bg:#0f1115;--fg:#e8eaee;--fg2:#a3abb7;--line:#2a2f38;--card:#171a20;--accent:#7aa7f0;--note:#18233a;color-scheme:dark}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.6 "IBM Plex Sans","IBM Plex Sans Hebrew",system-ui,sans-serif}
.wrap{display:grid;grid-template-columns:240px minmax(0,1fr);gap:32px;max-width:1180px;margin:0 auto;padding:24px max(16px,env(safe-area-inset-right)) 64px max(16px,env(safe-area-inset-left))}
nav{position:sticky;top:16px;align-self:start;max-height:calc(100vh - 32px);overflow:auto;font-size:13px}
nav ol{list-style:none;margin:0;padding:0}
nav a{display:block;padding:4px 8px;border-radius:6px;color:var(--fg2);text-decoration:none}
nav a:hover{background:var(--card);color:var(--fg)}
main{min-width:0;max-width:820px}
h1{font-size:28px;line-height:1.25;margin:0 0 4px}
.tagline{color:var(--fg2);margin:0 0 24px}
h2{font-size:21px;margin:40px 0 8px;padding-top:16px;border-top:1px solid var(--line)}
h3{font-size:16px;margin:24px 0 4px}
h4{font-size:15px;margin:16px 0 4px;color:var(--fg2)}
h1,h2,h3{text-wrap:balance}
a{color:var(--accent)}
code{font:13px "IBM Plex Mono",ui-monospace,monospace;background:var(--card);border:1px solid var(--line);border-radius:4px;padding:0 4px}
kbd{font:12px "IBM Plex Mono",ui-monospace,monospace;background:var(--card);border:1px solid var(--line);border-bottom-width:2px;border-radius:4px;padding:0 5px;white-space:nowrap}
figure{margin:16px 0}
figure img{display:block;max-width:100%;height:auto;border:1px solid var(--line);border-radius:8px}
figcaption{font-size:13px;color:var(--fg2);margin-top:6px}
.note{background:var(--note);border-inline-start:3px solid var(--accent);padding:8px 12px;border-radius:6px;margin:12px 0}
.table{overflow-x:auto}
table{border-collapse:collapse;width:100%;margin:12px 0;font-size:14px}
th,td{border-bottom:1px solid var(--line);padding:6px 8px;text-align:start;vertical-align:top}
th{color:var(--fg2);font-weight:600}
@media (max-width:820px){.wrap{grid-template-columns:1fr}nav{position:static;max-height:none}}
@media print{nav{display:none}.wrap{display:block}}
`;

async function main() {
  fs.mkdirSync(OUT, { recursive: true });
  // The app passes its theme (?theme=dark|light); a file, as the desktop app allows no inline script.
  fs.writeFileSync(path.join(OUT, "theme.js"), 'var m = /[?&]theme=(dark|light)/.exec(location.search);\nif (m) document.documentElement.setAttribute("data-theme", m[1]);\n');
  const I18N = await import(require("node:url").pathToFileURL(path.join(ROOT, "packages/shared/src/i18n.ts")).href);
  const langs = fs.readdirSync(SRC).filter((f) => /^[a-z]{2}\.md$/.test(f)).map((f) => f.slice(0, 2));
  for (const lang of langs) {
    const S = I18N[lang];
    const app = S.app.name;
    const md = fs.readFileSync(path.join(SRC, `${lang}.md`), "utf8").replace(/\{\{app\}\}/g, app);
    const [, title = app] = md.match(/^#\s+(.*)$/m) ?? [];
    const { body, toc } = render(md, lang);
    const dir = path.join(OUT, lang);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(path.join(dir, "img"), { recursive: true });
    const img = path.join(SRC, "img", lang);
    if (fs.existsSync(img)) for (const f of fs.readdirSync(img)) fs.copyFileSync(path.join(img, f), path.join(dir, "img", f));
    const rtl = lang === "he";
    const contents = lang === "he" ? "תוכן" : "Contents";
    const html = `<!doctype html>
<html lang="${lang}" dir="${rtl ? "rtl" : "ltr"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>${esc(title)}</title>
<style>${CSS}</style>
<script src="../theme.js"></script>
</head>
<body>
<div class="wrap">
<nav aria-label="${contents}"><ol>${toc.map(([id, t]) => `<li><a href="#${id}">${inline(t)}</a></li>`).join("")}</ol></nav>
<main>
${body.replace(/<\/h1>/, `</h1><p class="tagline">${esc(S.app.tagline)}</p>`)}
</main>
</div>
</body>
</html>
`;
    fs.writeFileSync(path.join(dir, "index.html"), html);
    console.log(`manual: ${lang} (${toc.length} sections)`);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
