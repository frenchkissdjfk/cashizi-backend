import express from "express";
import axios from "axios";
import cors from "cors";
import NodeCache from "node-cache";
import * as cheerio from "cheerio";

const app = express();
const PORT = process.env.PORT || 10000;
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "15mb" }));

const GEMINI_KEY = process.env.GEMINI_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT = process.env.EBAY_CERT;

/* =========================
   SAFE JSON
========================= */

function safeJSON(text) {
  try {
    return JSON.parse(text);
  } catch {}

  const match = text?.match(/\{[\s\S]*\}/);
  if (!match) return {};

  try {
    return JSON.parse(match[0]);
  } catch {
    return {};
  }
}

/* =========================
   GEMINI CALL
========================= */

const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callGemini(payload) {
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_KEY}`;

    try {
      const res = await axios.post(url, payload, { timeout: 30000 });
      return res.data;
    } catch (e) {
      if (e.response?.status === 503) {
        await sleep(800);
        continue;
      }
    }
  }
  return null;
}

/* =========================
   OBJECT RECOGNITION (UNIVERSAL)
========================= */

async function recognizeObject(images) {
  const parts = images.slice(0, 3).map(b64 => ({
    inline_data: { mime_type: "image/jpeg", data: b64 }
  }));

  const payload = {
    contents: [{
      parts: [
        ...parts,
        {
          text: `
Tu identifies tout objet visible (très important).

Retour JSON:
{
 "objectName": "",
 "category": "",
 "confidence": 0.0
}

Règles:
- jamais unknown
- toujours une hypothèse réaliste
`
        }
      ]
    }]
  };

  const data = await callGemini(payload);

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  const obj = safeJSON(text);

  return obj.objectName
    ? obj
    : { objectName: "Objet générique", category: "general", confidence: 0.3 };
}

/* =========================
   EBAY PRICES (API OFFICIELLE)
========================= */

async function getEbayPrices(query) {
  const key = `ebay_${query}`;
  const cached = cache.get(key);
  if (cached) return cached;

  try {
    const tokenRes = await axios.post(
      "https://api.ebay.com/identity/v1/oauth2/token",
      "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
      {
        headers: {
          Authorization: `Basic ${Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT}`).toString("base64")}`,
          "Content-Type": "application/x-www-form-urlencoded"
        }
      }
    );

    const token = tokenRes.data.access_token;

    const res = await axios.get(
      "https://api.ebay.com/buy/browse/v1/item_summary/search",
      {
        params: { q: query, limit: 20 },
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR"
        }
      }
    );

    const prices = (res.data.itemSummaries || [])
      .map(i => Number(i.price?.value))
      .filter(Boolean)
      .sort((a, b) => a - b);

    if (!prices.length) return null;

    return {
      min: prices[Math.floor(prices.length * 0.25)],
      max: prices[Math.floor(prices.length * 0.75)],
      source: "ebay"
    };

  } catch {
    return null;
  }
}

/* =========================
   LEBONCOIN SCRAPING
========================= */

async function getLeboncoinPrices(query) {
  try {
    const url = `https://www.leboncoin.fr/recherche?text=${encodeURIComponent(query)}`;

    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(data);
    const prices = [];

    $("[data-qa-id='aditem_price']").each((_, el) => {
      const txt = $(el).text().replace(/[^\d]/g, "");
      const p = parseInt(txt);
      if (p > 0) prices.push(p);
    });

    if (!prices.length) return null;

    prices.sort((a,b)=>a-b);

    return {
      min: prices[Math.floor(prices.length * 0.2)],
      max: prices[Math.floor(prices.length * 0.8)],
      source: "lbc"
    };

  } catch {
    return null;
  }
}

/* =========================
   VINTED SCRAPING
========================= */

async function getVintedPrices(query) {
  try {
    const url = `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}`;

    const { data } = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(data);
    const prices = [];

    $("[class*='price']").each((_, el) => {
      const txt = $(el).text().replace(/[^\d]/g, "");
      const p = parseInt(txt);
      if (p > 0) prices.push(p);
    });

    if (!prices.length) return null;

    prices.sort((a,b)=>a-b);

    return {
      min: prices[Math.floor(prices.length * 0.2)],
      max: prices[Math.floor(prices.length * 0.8)],
      source: "vinted"
    };

  } catch {
    return null;
  }
}

/* =========================
   HYBRID PRICE ENGINE (IMPORTANT)
========================= */

function mergePrices(prices) {
  const valid = prices.filter(Boolean);

  if (!valid.length) {
    return { min: 5, max: 30, source: "fallback" };
  }

  const mins = valid.map(p => p.min);
  const maxs = valid.map(p => p.max);

  return {
    min: Math.round(Math.min(...mins)),
    max: Math.round(Math.max(...maxs)),
    sources: valid.map(p => p.source)
  };
}

/* =========================
   MAIN ROUTE
========================= */

app.post("/analyze", async (req, res) => {
  try {
    const { images } = req.body;

    if (!images?.length) {
      return res.status(400).json({ error: "no images" });
    }

    console.log("📸 analyze hybrid");

    // 1. OBJECT
    const object = await recognizeObject(images);

    const query = object.objectName;

    // 2. PARALLEL PRICING (IMPORTANT PERF)
    const [ebay, lbc, vinted] = await Promise.all([
      getEbayPrices(query),
      getLeboncoinPrices(query),
      getVintedPrices(query)
    ]);

    // 3. MERGE PRICES
    const priceRange = mergePrices([ebay, lbc, vinted]);

    // 4. LISTING SIMPLE (STABLE)
    const listing = {
      title: object.objectName,
      description: "Objet en bon état. Fonctionnel.",
      priceMin: priceRange.min,
      priceMax: priceRange.max,
      suggestedPrice: Math.round((priceRange.min + priceRange.max) / 2),
      estimatedDays: 7,
      platform: "Leboncoin"
    };

    return res.json({
      object,
      prices: { ebay, lbc, vinted, merged: priceRange },
      listing,
      status: "success"
    });

  } catch (e) {
    console.error("CRASH:", e.message);

    return res.json({
      object: { objectName: "Objet générique", category: "general" },
      prices: { merged: { min: 5, max: 30 } },
      listing: {
        title: "Objet",
        priceMin: 5,
        priceMax: 30,
        description: "Estimation approximative"
      },
      status: "fallback"
    });
  }
});

/* =========================
   HEALTH
========================= */

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("🚀 HYBRID OBJECT AI READY");
});