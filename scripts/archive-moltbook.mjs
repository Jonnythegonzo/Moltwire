#!/usr/bin/env node
/**
 * Archive latest Moltbook posts by JonnyRobotson into docs/posts/ and update docs/index.html + docs/feed.xml.
 *
 * Secrets:
 * - Reads Moltbook API key from ~/.openclaw-jonny/credentials/moltbook-robotson.json
 * - Uses SSH deploy key configured via GIT_SSH_COMMAND when pushing.
 *
 * State:
 * - workspace/memory/moltwire-archive-state.json (public post ids only)
 */

import fs from 'node:fs';
import path from 'node:path';

const REPO_DIR = process.env.MOLTWIRE_REPO_DIR || '/home/ubuntu/.openclaw/workspace/repos/Moltwire.git';
const STATE_PATH = process.env.MOLTWIRE_ARCHIVE_STATE || '/home/ubuntu/.openclaw/workspace/memory/moltwire-archive-state.json';
const CREDS_PATH = process.env.MOLTBOOK_CREDS || '/home/ubuntu/.openclaw-jonny/credentials/moltbook-robotson.json';

const AGENT_NAME = process.env.MOLTBOOK_AGENT_NAME || 'JonnyRobotson';
const API_BASE = 'https://www.moltbook.com/api/v1';

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'));
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify(obj, null, 2) + '\n');
}

function isoDate(d = new Date()) {
  return d.toISOString().slice(0, 10);
}

function htmlEscape(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

function toSlug(title) {
  return String(title || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'dispatch';
}

async function fetchJson(url, { apiKey } = {}) {
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const res = await fetch(url, { headers });
  const txt = await res.text();
  if (!res.ok) {
    throw new Error(`HTTP ${res.status} for ${url}: ${txt.slice(0, 300)}`);
  }
  return JSON.parse(txt);
}

function renderPostHtml({ title, content, created_at, moltUrl }) {
  const created = created_at ? new Date(created_at) : new Date();
  const contentHtml = htmlEscape(content).replace(/\n/g, '<br/>\n');
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8"/>
  <meta name="viewport" content="width=device-width, initial-scale=1"/>
  <title>${htmlEscape(title)} | MoltWire</title>
  <meta name="description" content="${htmlEscape(title)}"/>
  <style>
    body{max-width:820px;margin:40px auto;padding:0 16px;font:16px/1.55 ui-monospace,SFMono-Regular,Menlo,Monaco,Consolas,"Liberation Mono","Courier New",monospace;color:#111}
    a{color:#0a58ca}
    header{margin-bottom:24px}
    .meta{color:#666;font-size:14px}
    article{white-space:normal}
  </style>
</head>
<body>
<header>
  <p><a href="../index.html">← MoltWire</a></p>
  <h1>${htmlEscape(title)}</h1>
  <p class="meta">${created.toISOString()} · Source: <a href="${moltUrl}">Moltbook</a></p>
</header>
<article>${contentHtml}</article>
</body>
</html>
`;
}

function upsertIndex({ indexHtml, entryHtml }) {
  // Insert new entry at top of the existing <ul class="postlist">.
  const needle = '<ul class="postlist">';
  const idx = indexHtml.indexOf(needle);
  if (idx === -1) {
    // fallback: append at end
    return indexHtml + `\n${entryHtml}\n`;
  }

  const insertAt = idx + needle.length;
  const after = indexHtml.slice(insertAt);

  const href = entryHtml.split('href="')[1]?.split('"')[0];
  if (href && indexHtml.includes(`href="${href}"`)) return indexHtml;

  return indexHtml.slice(0, insertAt) + `\n` + entryHtml + indexHtml.slice(insertAt);
}

function updateFeed({ feedXml, itemXml, guid }) {
  if (feedXml.includes(`<guid>${guid}</guid>`)) return feedXml;

  // Insert newest items at the top (before the first <item>).
  const firstItem = feedXml.indexOf('<item>');
  if (firstItem !== -1) {
    return feedXml.slice(0, firstItem) + itemXml + '\n\n' + feedXml.slice(firstItem);
  }

  const insertPoint = feedXml.indexOf('</channel>');
  if (insertPoint === -1) return feedXml + `\n${itemXml}\n`;
  return feedXml.slice(0, insertPoint) + `\n` + itemXml + `\n` + feedXml.slice(insertPoint);
}

function setLastBuildDate(feedXml, date = new Date()) {
  const d = date.toUTCString();
  if (feedXml.includes('<lastBuildDate>')) {
    return feedXml.replace(/<lastBuildDate>[\s\S]*?<\/lastBuildDate>/, `<lastBuildDate>${d}</lastBuildDate>`);
  }
  const langIdx = feedXml.indexOf('</language>');
  if (langIdx !== -1) {
    const insertAt = langIdx + '</language>'.length;
    return feedXml.slice(0, insertAt) + `\n    <lastBuildDate>${d}</lastBuildDate>` + feedXml.slice(insertAt);
  }
  return feedXml;
}

function setLatestSection(indexHtml) {
  const m = indexHtml.match(/<ul class="postlist">[\s\S]*?<a href="([^"]+)">([\s\S]*?)<\/a>[\s\S]*?<span class="meta">\((\d{4}-\d{2}-\d{2})\)<\/span>/);
  if (!m) return indexHtml;
  const [_, href, title, date] = m;
  const latestBlock = `<p><a href="${href}"><strong>${title}</strong></a><br/><span class="meta">${date}</span></p>`;

  if (indexHtml.includes('<!-- LATEST_START -->') && indexHtml.includes('<!-- LATEST_END -->')) {
    return indexHtml.replace(/<!-- LATEST_START -->[\s\S]*?<!-- LATEST_END -->/, `<!-- LATEST_START -->\n    ${latestBlock}\n    <!-- LATEST_END -->`);
  }
  return indexHtml;
}

async function main() {
  const creds = readJson(CREDS_PATH);
  const apiKey = creds?.agent?.api_key;
  if (!apiKey) throw new Error(`Missing api_key in ${CREDS_PATH}`);

  const state = readJson(STATE_PATH);

  const prof = await fetchJson(`${API_BASE}/agents/profile?name=${encodeURIComponent(AGENT_NAME)}`, { apiKey });
  const recent = prof.recentPosts || [];
  if (!recent.length) {
    console.log('No recent posts to archive.');
    return;
  }

  // Archive newest first, but only those we haven't archived.
  const lastArchived = state.lastArchivedPostId;
  const newPosts = [];
  for (const p of recent) {
    if (p.id === lastArchived) break;
    newPosts.push(p);
  }

  if (!newPosts.length) {
    console.log('No new posts since last archive.');
    state.lastCheckAt = new Date().toISOString();

    // Still keep the homepage "Latest Dispatch" section + RSS build date fresh.
    const docsDir = path.join(REPO_DIR, 'docs');
    const indexPath = path.join(docsDir, 'index.html');
    const feedPath = path.join(docsDir, 'feed.xml');

    let indexHtml = fs.readFileSync(indexPath, 'utf8');
    let feedXml = fs.readFileSync(feedPath, 'utf8');

    indexHtml = setLatestSection(indexHtml);
    feedXml = setLastBuildDate(feedXml);

    fs.writeFileSync(indexPath, indexHtml);
    fs.writeFileSync(feedPath, feedXml);

    writeJson(STATE_PATH, state);
    return;
  }

  // We'll archive from oldest->newest to keep chronological links sane.
  newPosts.reverse();

  const docsDir = path.join(REPO_DIR, 'docs');
  const postsDir = path.join(docsDir, 'posts');
  fs.mkdirSync(postsDir, { recursive: true });

  const indexPath = path.join(docsDir, 'index.html');
  const feedPath = path.join(docsDir, 'feed.xml');

  let indexHtml = fs.readFileSync(indexPath, 'utf8');
  let feedXml = fs.readFileSync(feedPath, 'utf8');

  const SITE_BASE = process.env.MOLTWIRE_SITE_BASE || 'https://jonnythegonzo.github.io/Moltwire';
  const SITE_POST_BASE = SITE_BASE.endsWith('/') ? SITE_BASE.slice(0, -1) : SITE_BASE;

  for (const p of newPosts) {
    const full = await fetchJson(`${API_BASE}/posts/${p.id}`, { apiKey });
    const post = full.post || full;
    const createdAt = post.created_at || p.created_at;
    const date = createdAt ? createdAt.slice(0, 10) : isoDate();
    const slug = toSlug(post.title);
    const filename = `${date}-${slug}-${p.id.slice(0, 8)}.html`;
    const relUrl = `./posts/${filename}`;

    const moltUrl = `https://www.moltbook.com/post/${p.id}`;

    const html = renderPostHtml({
      title: post.title,
      content: post.content || '',
      created_at: createdAt,
      moltUrl,
    });

    fs.writeFileSync(path.join(postsDir, filename), html);

    const entry = `      <li>\n        <a href="${relUrl}">${htmlEscape(post.title)}</a>\n        <span class="meta">(${htmlEscape(date)})</span>\n      </li>`;
    indexHtml = upsertIndex({ indexHtml, entryHtml: entry });

    const guid = `${SITE_POST_BASE}${relUrl.replace(/^\./, '')}`;
    const link = guid;
    const pubDate = new Date(createdAt || Date.now()).toUTCString();
    const desc = `<![CDATA[\n${(post.content || '').slice(0, 400)}\n]]>`;
    const item = `    <item>\n      <title>${htmlEscape(post.title)}</title>\n      <link>${htmlEscape(link)}</link>\n      <guid>${htmlEscape(guid)}</guid>\n      <pubDate>${htmlEscape(pubDate)}</pubDate>\n      <description>${desc}</description>\n    </item>`;
    feedXml = updateFeed({ feedXml, itemXml: item, guid });

    // Update state to newest archived
    state.lastArchivedPostId = p.id;
    state.lastArchivedAt = new Date().toISOString();
  }

  // Update homepage Latest section + RSS build date
  indexHtml = setLatestSection(indexHtml);
  feedXml = setLastBuildDate(feedXml);

  fs.writeFileSync(indexPath, indexHtml);
  fs.writeFileSync(feedPath, feedXml);

  writeJson(STATE_PATH, state);

  console.log(`Archived ${newPosts.length} post(s). Latest archived: ${state.lastArchivedPostId}`);
}

main().catch((err) => {
  console.error(err.stack || String(err));
  process.exit(1);
});
