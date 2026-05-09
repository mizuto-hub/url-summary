import http from "node:http";
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { extname, join, normalize } from "node:path";
import { readFile } from "node:fs/promises";

const PORT = Number(process.env.PORT || 3000);
const ROOT = join(process.cwd(), "public");
const MAX_BYTES = 1_500_000;
const REQUEST_TIMEOUT_MS = 12_000;
const USER_AGENT = "Mozilla/5.0 (compatible; SummaryService/1.0)";

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml"
};

const IMPORTANT_TERMS = [
  "おすすめ",
  "ランキング",
  "比較",
  "選び方",
  "メリット",
  "デメリット",
  "手数料",
  "利回り",
  "リスク",
  "運用",
  "実績",
  "NISA",
  "投資信託",
  "ファンド",
  "初心者",
  "注意",
  "ポイント",
  "結論"
];

const INTRO_PATTERNS = [
  "この記事では",
  "本記事では",
  "今回は",
  "ご紹介します",
  "紹介します",
  "解説します",
  "見ていきましょう",
  "参考にしてください"
];

const server = http.createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/summarize") {
      await handleSummarize(req, res);
      return;
    }

    if (req.method === "GET") {
      await serveStatic(req, res);
      return;
    }

    sendJson(res, 405, { error: "対応していないメソッドです。" });
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "サーバーでエラーが発生しました。" });
  }
});

server.listen(PORT, () => {
  console.log(`140字要約サービス: http://localhost:${PORT}`);
});

async function handleSummarize(req, res) {
  const body = await readBody(req);
  let payload;

  try {
    payload = JSON.parse(body);
  } catch {
    sendJson(res, 400, { error: "JSONの形式が正しくありません。" });
    return;
  }

  const inputUrl = String(payload.url || "").trim();
  let targetUrl;

  try {
    targetUrl = new URL(inputUrl);
  } catch {
    sendJson(res, 400, { error: "URLを正しく入力してください。" });
    return;
  }

  if (!["http:", "https:"].includes(targetUrl.protocol)) {
    sendJson(res, 400, { error: "http または https のURLだけ対応しています。" });
    return;
  }

  try {
    if (await isBlockedHost(targetUrl.hostname)) {
      sendJson(res, 400, { error: "ローカルまたはプライベートネットワークのURLは要約できません。" });
      return;
    }

    const html = await fetchHtml(targetUrl);
    const extracted = extractContent(html, targetUrl.href);
    const summary = summarizeAbout140(extracted);

    sendJson(res, 200, {
      title: extracted.title,
      summary,
      sourceUrl: targetUrl.href
    });
  } catch (error) {
    sendJson(res, 502, { error: error.message || "ページを取得できませんでした。" });
  }
}

async function serveStatic(req, res) {
  const requestUrl = new URL(req.url || "/", `http://${req.headers.host}`);
  const pathname = requestUrl.pathname === "/" ? "/index.html" : requestUrl.pathname;
  const safePath = normalize(decodeURIComponent(pathname)).replace(/^(\.\.[/\\])+/, "");
  const filePath = join(ROOT, safePath);

  if (!filePath.startsWith(ROOT)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }

  try {
    const file = await readFile(filePath);
    res.writeHead(200, {
      "content-type": MIME_TYPES[extname(filePath)] || "application/octet-stream",
      "cache-control": "no-store"
    });
    res.end(file);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

async function readBody(req) {
  const chunks = [];
  let total = 0;

  for await (const chunk of req) {
    total += chunk.length;
    if (total > 20_000) {
      throw new Error("Request body is too large.");
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks).toString("utf-8");
}

async function fetchHtml(url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      headers: { "user-agent": USER_AGENT, accept: "text/html,application/xhtml+xml" },
      redirect: "follow",
      signal: controller.signal
    });

    const contentType = response.headers.get("content-type") || "";
    if (!response.ok) {
      throw new Error(`ページを取得できませんでした。HTTP ${response.status}`);
    }
    if (!contentType.includes("text/html") && !contentType.includes("application/xhtml+xml")) {
      throw new Error("HTMLページではないため要約できません。");
    }

    const reader = response.body?.getReader();
    if (!reader) {
      throw new Error("ページ本文を読み込めませんでした。");
    }

    const chunks = [];
    let total = 0;

    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > MAX_BYTES) break;
      chunks.push(value);
    }

    return Buffer.concat(chunks).toString("utf-8");
  } catch (error) {
    if (error.name === "AbortError") {
      throw new Error("ページ取得がタイムアウトしました。");
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function extractContent(html, sourceUrl) {
  const cleanHtml = html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<(nav|header|footer|aside|form)[\s\S]*?<\/\1>/gi, " ");

  const title = normalizeText(htmlToText(matchContent(cleanHtml, /<title[^>]*>([\s\S]*?)<\/title>/i)));
  const description = normalizeText(decodeEntities(readMeta(cleanHtml, "description") || readMeta(cleanHtml, "og:description")));
  const headline = normalizeText(htmlToText(matchContent(cleanHtml, /<h1[^>]*>([\s\S]*?)<\/h1>/i)));
  const articleHtml = matchContent(cleanHtml, /<article[^>]*>([\s\S]*?)<\/article>/i) || cleanHtml;
  const blocks = extractBlocks(articleHtml);

  return {
    title: title || new URL(sourceUrl).hostname,
    description,
    headline,
    blocks,
    text: blocks.map((block) => block.text).join(" ")
  };
}

function extractBlocks(html) {
  const blocks = [];
  const tagRegex = /<(h2|h3|p|li|td|th)[^>]*>([\s\S]*?)<\/\1>/gi;
  let match;

  while ((match = tagRegex.exec(html))) {
    const tag = match[1].toLowerCase();
    const text = normalizeText(htmlToText(match[2]));

    if (!isUsefulBlock(text)) continue;
    blocks.push({ tag, text });
  }

  return dedupeBlocks(blocks).slice(0, 260);
}

function isUsefulBlock(text) {
  if (text.length < 12 || text.length > 260) return false;
  if (/^(PR|広告|目次|関連記事|あわせて読みたい|スポンサーリンク)$/i.test(text)) return false;
  if (/^[\d\s.,%円年月日:：/\\-]+$/.test(text)) return false;
  return true;
}

function dedupeBlocks(blocks) {
  const seen = new Set();
  return blocks.filter((block) => {
    const key = block.text.replace(/\s/g, "").slice(0, 80);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function summarizeAbout140({ title, description, headline, blocks, text }) {
  const targetLength = 140;
  const allText = [title, headline, description, text].filter(Boolean).join(" ");
  const investmentSummary = buildInvestmentFundSummary({ title, headline, blocks, text: allText }, targetLength);
  if (investmentSummary) {
    return investmentSummary;
  }

  const keywords = topKeywords(allText);
  const scoredBlocks = blocks
    .map((block, index) => ({
      ...block,
      index,
      score: scoreBlock(block, keywords, index, title)
    }))
    .sort((a, b) => b.score - a.score);

  const topics = extractTopics({ title, headline, blocks: scoredBlocks });
  const bestFacts = scoredBlocks
    .filter((block) => !looksLikeIntro(block.text))
    .filter((block) => block.tag !== "h2" || block.text.length >= 18)
    .slice(0, 8);

  const lead = buildLead(title, headline, topics);
  const detail = buildDetail(bestFacts, topics, targetLength - lead.length);
  const fallback = description || headline || title || "要約できる本文を見つけられませんでした。";

  return fitSummary([lead, detail].filter(Boolean).join(" "), targetLength, fallback);
}

function buildInvestmentFundSummary({ title, headline, blocks, text }, targetLength) {
  const pageTitle = `${title} ${headline}`;
  if (!/(投資信託|ファンド|NISA)/.test(pageTitle) || !/(おすすめ|ランキング|選び方|銘柄)/.test(pageTitle + text)) {
    return "";
  }

  const funds = extractNamedItems(blocks, /(eMAXIS|SBI|楽天|iFree|ニッセイ|たわら|インデックス|オルカン|S&P500|全世界株式|米国株式)/, 3);
  const criteria = ["手数料", "運用実績", "リスク", "デメリット", "選び方"].filter((term) => text.includes(term));
  const topic = pageTitle.includes("NISA") ? "新NISA向け投資信託" : "投資信託";
  const fundText = funds.length ? `${funds.join("、")}などの具体的な候補` : "具体的な候補銘柄";
  const criteriaText = criteria.length ? criteria.slice(0, 4).join("・") : "コスト・実績・リスク";
  const caution = text.includes("デメリット") || text.includes("注意") ? "購入前の注意点" : "選ぶ際の判断材料";

  return fitSummary(
    `${topic}のおすすめ銘柄を、${criteriaText}の観点で比較。${fundText}を取り上げ、${caution}まで含めて失敗しない選び方を整理しています。`,
    targetLength,
    title
  );
}

function extractNamedItems(blocks, pattern, limit) {
  const candidates = blocks
    .filter((block) => pattern.test(block.text))
    .map((block) => cleanupTopic(block.text))
    .map((text) => text.replace(/^(おすすめ)?[\d０-９]+位[:：\s-]*/, ""))
    .filter((text) => text.length >= 4 && text.length <= 48)
    .filter((text) => !looksLikeIntro(text));

  return unique(candidates).slice(0, limit);
}

function buildLead(title, headline, topics) {
  const topic = cleanTitle(headline || title);
  const listed = topics.slice(0, 3).join("、");

  if (listed) {
    return `${topic}について、${listed}などの要点を整理。`;
  }

  return `${topic}の要点を整理。`;
}

function buildDetail(blocks, topics, remainingLength) {
  const fragments = [];

  for (const block of blocks) {
    const fragment = compressSentence(block.text);
    if (!fragment || topics.some((topic) => fragment === topic)) continue;
    if (looksLikeIntro(fragment)) continue;

    const next = [...fragments, fragment].join(" ");
    if (fragments.length > 0 && next.length > Math.max(60, remainingLength + 20)) break;
    fragments.push(fragment);
    if (next.length >= Math.max(45, remainingLength - 15)) break;
  }

  return fragments.join(" ");
}

function extractTopics({ title, headline, blocks }) {
  const titleWords = topKeywords(`${title} ${headline}`).slice(0, 5);
  const headingTopics = blocks
    .filter((block) => ["h2", "h3", "li"].includes(block.tag))
    .map((block) => cleanupTopic(block.text))
    .filter((text) => text.length >= 3 && text.length <= 34)
    .filter((text) => !looksLikeIntro(text))
    .filter((text) => !titleWords.some((word) => text === word));

  const important = headingTopics.filter((text) => IMPORTANT_TERMS.some((term) => text.includes(term)));
  return unique([...important, ...headingTopics]).slice(0, 5);
}

function cleanupTopic(text) {
  return normalizeText(text)
    .replace(/^[\d０-９]+[.)．位、\s-]*/, "")
    .replace(/^第[\d０-９一二三四五六七八九十]+[章位]?\s*/, "")
    .replace(/[。.!?！？]*$/, "")
    .trim();
}

function cleanTitle(text) {
  return normalizeText(text)
    .replace(/\s*[|｜-]\s*[^|｜-]+$/, "")
    .replace(/[【】]/g, "")
    .replace(/[。.!?！？]*$/, "")
    .slice(0, 54);
}

function compressSentence(text) {
  const sentence = splitSentences(text)[0] || text;
  return normalizeText(sentence)
    .replace(/[。.!?！？]*$/, "")
    .replace(/^つまり、?/, "")
    .trim();
}

function fitSummary(summary, targetLength, fallback) {
  const clean = normalizeText(summary || fallback).replace(/[。.!?！？]*$/, "");
  const maxLength = targetLength + 25;

  if (clean.length <= maxLength) {
    return `${clean}。`;
  }

  return `${clean.slice(0, maxLength - 3).replace(/[、,;；:：]\s*[^、,;；:：]*$/, "")}...`;
}

function scoreBlock(block, keywords, index, title) {
  const text = block.text;
  const lower = text.toLowerCase();
  const tagScore = { h2: 12, h3: 9, li: 7, p: 4, th: 4, td: 3 }[block.tag] || 1;
  const keywordScore = keywords.reduce((score, keyword) => score + (lower.includes(keyword) ? 3 : 0), 0);
  const importantScore = IMPORTANT_TERMS.reduce((score, term) => score + (text.includes(term) ? 4 : 0), 0);
  const titleScore = topKeywords(title).reduce((score, keyword) => score + (lower.includes(keyword) ? 4 : 0), 0);
  const numberScore = /[\d０-９]+/.test(text) ? 3 : 0;
  const lengthScore = text.length >= 24 && text.length <= 120 ? 5 : 0;
  const introPenalty = looksLikeIntro(text) ? -18 : 0;
  const positionScore = Math.max(0, 8 - index * 0.05);

  return tagScore + keywordScore + importantScore + titleScore + numberScore + lengthScore + introPenalty + positionScore;
}

function looksLikeIntro(text) {
  return INTRO_PATTERNS.some((pattern) => text.includes(pattern));
}

function splitSentences(text) {
  const normalized = normalizeText(text);
  return (normalized.match(/[^。！？!?]+[。！？!?]?/g) || [])
    .map((sentence) => sentence.trim())
    .filter(Boolean);
}

function topKeywords(text) {
  const stopWords = new Set([
    "こと",
    "もの",
    "ため",
    "よう",
    "これ",
    "それ",
    "こちら",
    "について",
    "ます",
    "です",
    "する",
    "した",
    "いる",
    "ある",
    "まとめ",
    "記事",
    "方法",
    "with",
    "that",
    "this",
    "from",
    "have",
    "and",
    "the"
  ]);
  const counts = new Map();
  const words = normalizeText(text).match(/[一-龠ぁ-んァ-ヶーA-Za-z0-9]{2,}/g) || [];

  for (const word of words) {
    const lower = word.toLowerCase();
    if (stopWords.has(lower) || lower.length < 2) continue;
    counts.set(lower, (counts.get(lower) || 0) + 1);
  }

  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 16)
    .map(([word]) => word);
}

function unique(values) {
  const seen = new Set();
  return values.filter((value) => {
    const key = value.replace(/\s/g, "");
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function htmlToText(html) {
  return decodeEntities(
    String(html || "")
      .replace(/<br\s*\/?>/gi, " ")
      .replace(/<\/(p|div|li|h[1-6]|td|th)>/gi, " ")
      .replace(/<[^>]+>/g, " ")
  );
}

function normalizeText(text) {
  return String(text || "")
    .replace(/\s+/g, " ")
    .replace(/\u00a0/g, " ")
    .trim();
}

function decodeEntities(text) {
  const entities = {
    amp: "&",
    lt: "<",
    gt: ">",
    quot: '"',
    apos: "'",
    nbsp: " "
  };

  return String(text || "")
    .replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code)))
    .replace(/&#x([\da-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16)))
    .replace(/&([a-z]+);/gi, (_, name) => entities[name.toLowerCase()] || `&${name};`);
}

function matchContent(text, regex) {
  const match = text.match(regex);
  return match ? match[1] : "";
}

function readMeta(html, name) {
  const tags = html.match(/<meta\b[^>]*>/gi) || [];
  const wanted = name.toLowerCase();

  for (const tag of tags) {
    const nameValue = readAttribute(tag, "name") || readAttribute(tag, "property");
    if (nameValue?.toLowerCase() === wanted) {
      return readAttribute(tag, "content") || "";
    }
  }

  return "";
}

function readAttribute(tag, attribute) {
  const regex = new RegExp(`${attribute}=["']([^"']*)["']`, "i");
  return matchContent(tag, regex);
}

async function isBlockedHost(hostname) {
  const normalized = hostname.toLowerCase();
  if (["localhost", "0.0.0.0"].includes(normalized) || normalized.endsWith(".localhost")) {
    return true;
  }

  const addresses = isIP(normalized)
    ? [{ address: normalized }]
    : await withTimeout(lookup(normalized, { all: true }), REQUEST_TIMEOUT_MS, "DNSの解決がタイムアウトしました。");
  return addresses.some(({ address }) => isPrivateAddress(address));
}

function withTimeout(promise, ms, message) {
  let timeout;
  const timer = new Promise((_, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });

  return Promise.race([promise, timer]).finally(() => clearTimeout(timeout));
}

function isPrivateAddress(address) {
  if (address === "::1") return true;

  if (address.startsWith("fc") || address.startsWith("fd") || address.startsWith("fe80:")) {
    return true;
  }

  const parts = address.split(".").map(Number);
  if (parts.length !== 4 || parts.some(Number.isNaN)) {
    return false;
  }

  const [a, b] = parts;
  return (
    a === 10 ||
    a === 127 ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 168) ||
    (a === 169 && b === 254)
  );
}

function sendJson(res, status, payload) {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(payload));
}
