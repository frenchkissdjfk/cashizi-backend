import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import NodeCache from "node-cache";

const app = express();
const PORT = process.env.PORT || 10000;
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "15mb" }));

const GEMINI_KEY = process.env.GEMINI_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT = process.env.EBAY_CERT;

if (!GEMINI_KEY) {
  console.error("❌ GEMINI_KEY manquante");
  process.exit(1);
}

/* =========================
   🔥 GEMINI ROBUST CALLER
========================= */

const GEMINI_MODELS = [
  "gemini-2.5-flash",
  "gemini-2.5-flash-lite",
  "gemini-2.0-flash"
];

async function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

async function callGemini(payload) {
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1/models/${model}:generateContent?key=${GEMINI_KEY}`;

    try {
      const res = await axios.post(url, payload, {
        timeout: 30000,
        headers: { "Content-Type": "application/json" }
      });

      return res.data;
    } catch (e) {
      const status = e.response?.status;

      console.warn(`⚠️ Gemini fail ${model} (${status})`);

      // 503 = overload → retry léger
      if (status === 503) {
        await sleep(800);
        continue;
      }

      // 404 model → skip
      continue;
    }
  }

  throw new Error("Tous les modèles Gemini ont échoué");
}

/* =========================
   🧠 VISION PRODUCT
========================= */

async function recognizeProduct(images) {
  const imageParts = images.slice(0, 3).map(b64 => ({
    inline_data: { mime_type: "image/jpeg", data: b64 }
  }));

  const payload = {
    contents: [{
      parts: [
        ...imageParts,
        {
          text: `
Analyse ces images produit.

Réponds UNIQUEMENT en JSON :
{
 "productName": "",
 "brand": null,
 "model": null,
 "condition": "excellent|bon|passable|mauvais",
 "category": "",
 "confidence": 0.0
}
`
        }
      ]
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512
    }
  };

  const data = await callGemini(payload);
  const text = data.candidates[0].content.parts[0].text;

  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

/* =========================
   💰 EBAY (REAL PRICE)
========================= */

async function getEbayPrices(query) {
  const cacheKey = `ebay_${query}`;
  const cached = cache.get(cacheKey);
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

    const result = {
      min: prices[Math.floor(prices.length * 0.25)],
      max: prices[Math.floor(prices.length * 0.75)],
      count: prices.length
    };

    cache.set(cacheKey, result);
    return result;

  } catch {
    return null;
  }
}

/* =========================
   🧠 DECISION AI (ANNONCE)
========================= */

async function generateListing(product, prices) {
  const payload = {
    contents: [{
      parts: [{
        text: `
Produit: ${product.productName}
Marque: ${product.brand || "unknown"}

Prix marché:
${JSON.stringify(prices)}

Réponds JSON:
{
 "priceMin": 0,
 "priceMax": 0,
 "suggestedPrice": 0,
 "estimatedDays": 0,
 "title": "",
 "description": "",
 "platform": "Leboncoin",
 "confidence": 0.0
}
`
      }]
    }]
  };

  const data = await callGemini(payload);
  const text = data.candidates[0].content.parts[0].text;

  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

/* =========================
   🚀 MAIN ROUTE
========================= */

app.post("/analyze", async (req, res) => {
  try {
    const { images } = req.body;
    if (!images?.length) {
      return res.status(400).json({ error: "no images" });
    }

    console.log("📸 analyse...");

    const product = await recognizeProduct(images);

    const query = product.productName;

    const prices = await getEbayPrices(query);

    const listing = await generateListing(product, prices);

    return res.json({
      product,
      prices,
      listing,
      status: "success"
    });

  } catch (e) {
    console.error("❌ CRASH:", e.message);
    res.status(500).json({ error: e.message });
  }
});

/* =========================
   HEALTH
========================= */

app.get("/health", (_, res) => {
  res.json({ ok: true });
});

app.listen(PORT, () => {
  console.log("🚀 backend ready on", PORT);
});