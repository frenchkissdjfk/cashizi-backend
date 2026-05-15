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
        await sleep(800);
        continue;
      }
    }
  }
  return null;
}

/* =========================
   OCR (Tesseract SAFE)
========================= */

async function runOCR(images = []) {
  try {
    const img = images[0];
    if (!img) return "";

    const cached = cache.get(img);
    if (cached) return cached;

    const { data } = await Tesseract.recognize(img, "fra+eng", {
      logger: () => {}
    });

    const text = (data.text || "").trim().slice(0, 200);
    cache.set(img, text);
    return text;

  } catch (e) {
    console.log("OCR FAIL");
    return "";
  }
}

/* =========================
   VISION + OCR FUSION
========================= */

async function recognizeObject(images) {

  const ocrText = await runOCR(images);

  const parts = images.slice(0, 2).map(b64 => ({
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
Tu es Google Lens expert.

OCR TEXTE DETECTE:
${ocrText || "NONE"}

Retour JSON STRICT:
{
 "objectName": "",
 "category": "",
 "brand": "",
 "model": "",
 "confidence": 0.0
}

Ne répond jamais unknown.
`
        }
      ]
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 180
    }
  };

  const data = await callGemini(payload);

  const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || "";

  let obj = safeJSON(text);

  if (!obj) {
    return {
      objectName: "Objet occasion",
      category: "general",
      brand: null,
      model: null,
      confidence: 0.3
    };
  }

  return {
    objectName: obj.objectName || "Objet occasion",
    category: obj.category || "general",
    brand: obj.brand || null,
    model: obj.model || null,
    confidence: obj.confidence || 0.4,
    ocr: ocrText
  };
}

/* =========================
   EBAY
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

    const prices =
      (res.data.itemSummaries || [])
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
    console.log("EBAY FAIL");
    return null;
  }
}

/* =========================
   LBC
========================= */

async function getLeboncoinPrices(query) {
  try {
    const url = `https://www.leboncoin.fr/recherche?text=${encodeURIComponent(query)}`;
    const { data } = await axios.get(url, {
      timeout: 12000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(data);

    const prices = [];
    $("[data-qa-id='aditem_price']").each((_, el) => {
      const p = parseInt($(el).text().replace(/[^\d]/g, ""));
      if (p > 0 && p < 50000) prices.push(p);
    });

    if (!prices.length) return null;

    prices.sort((a, b) => a - b);

    return {
      min: prices[Math.floor(prices.length * 0.2)],
      max: prices[Math.floor(prices.length * 0.8)],
      source: "lbc"
    };

  } catch {
    console.log("LBC FAIL");
    return null;
  }
}

/* =========================
   VINTED
========================= */

async function getVintedPrices(query) {
  try {
    const url = `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}`;

    const { data } = await axios.get(url, {
      timeout: 12000,
      headers: { "User-Agent": "Mozilla/5.0" }
    });

    const $ = cheerio.load(data);

    const prices = [];
    $("[class*='price']").each((_, el) => {
      const p = parseInt($(el).text().replace(/[^\d]/g, ""));
      if (p > 0 && p < 50000) prices.push(p);
    });

    if (!prices.length) return null;

    prices.sort((a, b) => a - b);

    return {
      min: prices[Math.floor(prices.length * 0.2)],
      max: prices[Math.floor(prices.length * 0.8)],
      source: "vinted"
    };

  } catch {
    console.log("VINTED FAIL");
    return null;
  }
}

/* =========================
   MERGE
========================= */

function mergePrices(prices) {
  const valid = prices.filter(Boolean);

  if (!valid.length) return { min: 5, max: 30, source: "fallback" };

  return {
    min: Math.round(Math.min(...valid.map(p => p.min))),
    max: Math.round(Math.max(...valid.map(p => p.max))),
    sources: valid.map(v => v.source)
  };
}

/* =========================
   MAIN
========================= */

app.post("/analyze", async (req, res) => {
  try {
    const { images } = req.body;
    if (!images?.length) return res.status(400).json({ error: "no images" });

    const object = await recognizeObject(images);

    const query = [object.brand, object.model, object.objectName]
      .filter(Boolean)
      .join(" ");

    const [ebay, lbc, vinted] = await Promise.all([
      getEbayPrices(query),
      getLeboncoinPrices(query),
      getVintedPrices(query)
    ]);

    const priceRange = mergePrices([ebay, lbc, vinted]);

    res.json({
      status: "success",
      product: object,
      priceMin: priceRange.min,
      priceMax: priceRange.max,
      suggestedPrice: Math.round((priceRange.min + priceRange.max) / 2),
      debug: { ebay, lbc, vinted }
    });

  } catch (e) {
    console.error("CRASH:", e.message);

    res.json({
      status: "fallback",
      product: { objectName: "Objet occasion", category: "general" },
      priceMin: 5,
      priceMax: 30,
      suggestedPrice: 15
    });
  }
});

app.get("/health", (_, res) => res.json({ ok: true }));

app.listen(PORT, () => {
  console.log("🚀 HYBRID LENS AI READY");
});