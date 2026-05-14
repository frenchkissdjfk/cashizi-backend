import express from "express";
import axios from "axios";
import cors from "cors";
import NodeCache from "node-cache";
import * as cheerio from "cheerio";
import Tesseract from "tesseract.js";

const app = express();
const PORT = process.env.PORT || 10000;
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "25mb" }));

const GEMINI_KEY = process.env.GEMINI_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT = process.env.EBAY_CERT;

/* =========================
   SAFE JSON
========================= */

function safeJSON(text) {
  if (!text) return null;

  try {
    return JSON.parse(text);
  } catch {}

  let cleaned = text
    .replace(/```json/g, "")
    .replace(/```/g, "")
    .trim();

  if (!cleaned.endsWith("}")) {
    cleaned += '"}';
  }

  try {
    return JSON.parse(cleaned);
  } catch {}

  const match = cleaned.match(/\{[\s\S]*\}/);

  if (!match) return null;

  try {
    return JSON.parse(match[0]);
  } catch {}

  return null;
}

/* =========================
   GEMINI CALL
========================= */

const MODELS = ["gemini-2.5-flash", "gemini-2.5-flash-lite"];

const sleep = (ms) => new Promise(r => setTimeout(r, ms));

async function callGemini(payload) {
  for (const model of MODELS) {
    const url =
      `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_KEY}`;

    try {
      const res = await axios.post(url, payload, {
        timeout: 30000,
        headers: { "Content-Type": "application/json" }
      });

      return res.data;
    } catch (e) {
      console.log("⚠️ GEMINI FAIL:", model);
      if (e.response?.status === 503) {
        await sleep(1000);
        continue;
      }
    }
  }
  return null;
}

/* =========================
   OCR (TESSERACT)
========================= */

async function runOCR(images) {
  try {
    const results = await Promise.all(
      images.slice(0, 2).map(async (img) => {
        const res = await Tesseract.recognize(img, "eng+fra", {
          logger: () => {}
        });
        return res.data.text || "";
      })
    );

    return results.join(" ");
  } catch {
    return "";
  }
}

/* =========================
   OBJECT RECOGNITION
========================= */

async function recognizeObject(images) {
  const parts = images.slice(0, 3).map(b64 => ({
    inline_data: {
      mime_type: "image/jpeg",
      data: b64
    }
  }));

  const payload = {
    contents: [{
      parts: [
        ...parts,
        {
          text: `
Tu es un expert mondial de reconnaissance d’objets d’occasion.

Retour JSON STRICT :
{
  "objectName": "",
  "category": "",
  "brand": "",
  "model": "",
  "confidence": 0.0
}
`
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 150
    }
  };

  const data = await callGemini(payload);

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  console.log("VISION RAW:", text);

  if (!text.includes("}") || text.length < 20) {
    return {
      objectName: "Objet occasion",
      category: "general",
      brand: null,
      model: null,
      confidence: 0.3
    };
  }

  const obj = safeJSON(text);

  if (!obj) {
    return {
      objectName: "Objet occasion",
      category: "general",
      brand: null,
      model: null,
      confidence: 0.3
    };
  }

  return obj;
}

/* =========================
   EBAY / LBC / VINTED (UNCHANGED)
========================= */

async function getEbayPrices(query) {
  try {
    const tokenRes = await axios.post(
      "https://api.ebay.com/identity/v1/oauth2/token",
      "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
      {
        headers: {
          Authorization:
            `Basic ${Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT}`).toString("base64")}`,
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

async function getLeboncoinPrices(query) {
  try {
    const url = `https://www.leboncoin.fr/recherche?text=${encodeURIComponent(query)}`;

    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(data);
    const prices = [];

    $("[data-qa-id='aditem_price']").each((_, el) => {
      const p = parseInt($(el).text().replace(/[^\d]/g, ""));
      if (p > 0) prices.push(p);
    });

    if (!prices.length) return null;

    prices.sort((a, b) => a - b);

    return {
      min: prices[Math.floor(prices.length * 0.2)],
      max: prices[Math.floor(prices.length * 0.8)],
      source: "lbc"
    };
  } catch {
    return null;
  }
}

async function getVintedPrices(query) {
  try {
    const url = `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}`;

    const { data } = await axios.get(url, {
      timeout: 15000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(data);
    const prices = [];

    $("[class*='price']").each((_, el) => {
      const p = parseInt($(el).text().replace(/[^\d]/g, ""));
      if (p > 0) prices.push(p);
    });

    if (!prices.length) return null;

    prices.sort((a, b) => a - b);

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
   MERGE
========================= */

function mergePrices(prices) {
  const valid = prices.filter(Boolean);

  if (!valid.length) {
    return { min: 5, max: 30, source: "fallback" };
  }

  return {
    min: Math.round(Math.min(...valid.map(p => p.min))),
    max: Math.round(Math.max(...valid.map(p => p.max))),
    sources: valid.map(v => v.source)
  };
}

/* =========================
   LENS QUERY FUSION
========================= */

function buildLensQuery(vision, ocr) {
  const base = [
    vision.brand,
    vision.model,
    vision.objectName
  ].filter(Boolean).join(" ");

  if (!ocr) return base;

  const clean = ocr
    .replace(/[^a-zA-Z0-9À-ÿ\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  return `${base} ${clean}`.trim();
}

/* =========================
   MAIN ROUTE
========================= */

app.post("/analyze", async (req, res) => {
  try {

    const { images } = req.body;
    if (!images?.length) return res.status(400).json({ error: "no images" });

    console.log("📸 analyze hybrid");

    const object = await recognizeObject(images);

    const ocrText = await runOCR(images);
    console.log("OCR:", ocrText);

    const query = buildLensQuery(object, ocrText);
    console.log("QUERY:", query);

    const [ebay, lbc, vinted] = await Promise.all([
      getEbayPrices(query),
      getLeboncoinPrices(query),
      getVintedPrices(query)
    ]);

    const priceRange = mergePrices([ebay, lbc, vinted]);

    const listing = {
      title: object.objectName,
      priceMin: priceRange.min,
      priceMax: priceRange.max,
      suggestedPrice: Math.round((priceRange.min + priceRange.max) / 2),
      estimatedDays: 7
    };

    return res.json({
      status: "success",
      product: object,
      ocr: ocrText,
      query,
      priceMin: priceRange.min,
      priceMax: priceRange.max,
      suggestedPrice: listing.suggestedPrice,
      listing,
      debug: { ebay, lbc, vinted }
    });

  } catch (e) {
    return res.json({
      status: "fallback",
      error: e.message
    });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => console.log("🚀 READY"));