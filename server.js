// ═══════════════════════════════════════════════════════════════════════
//  CASHIZI — Backend production
//  Fix principal : URL Gemini corrigée → /v1beta/ (et non /v1/)
//  Render free tier compatible (512 MB RAM, pas de Tesseract)
// ═══════════════════════════════════════════════════════════════════════

import express   from "express";
import axios     from "axios";
import cors      from "cors";
import NodeCache from "node-cache";
import * as cheerio from "cheerio";

const app   = express();
const PORT  = process.env.PORT || 10000;
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "25mb" }));

const GEMINI_KEY  = process.env.GEMINI_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT   = process.env.EBAY_CERT;

if (!GEMINI_KEY) {
  console.error("❌  GEMINI_KEY manquante");
  process.exit(1);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Modèles Gemini — ordre de préférence ─────────────────────────────
// L'URL correcte est /v1beta/ (pas /v1/)
// Référence : https://ai.google.dev/api/generate-content
const GEMINI_MODELS = [
  "gemini-2.0-flash-exp",   // le plus récent avec vision, gratuit
  "gemini-1.5-flash",       // stable, très rapide
  "gemini-1.5-flash-8b",    // ultra-léger si quota épuisé
];

// ════════════════════════════════════════════════════════════════════════
//  Appel Gemini — v1beta — avec fallback sur plusieurs modèles
// ════════════════════════════════════════════════════════════════════════
async function callGemini(payload, timeoutMs = 28000) {
  for (const model of GEMINI_MODELS) {
    // ⚠️  /v1beta/ obligatoire — /v1/ renvoie 404 sur ces modèles
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

    try {
      const res = await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: timeoutMs,
      });

      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (text.length > 5) {
        console.log(`✅ Gemini OK — modèle: ${model}`);
        return text;
      }
      console.warn(`⚠️  Gemini ${model} → réponse vide`);
    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.error?.message || err.message;
      console.warn(`⚠️  Gemini ${model} → HTTP ${status || "?"} — ${msg}`);

      if (status === 429) {
        await sleep(2000); // quota → attendre avant prochain modèle
      }
      // 404 = modèle inexistant → passe au suivant immédiatement
    }
  }

  console.error("❌  Tous les modèles Gemini ont échoué");
  return null;
}

// ════════════════════════════════════════════════════════════════════════
//  Extraction JSON robuste
// ════════════════════════════════════════════════════════════════════════
function extractJSON(text) {
  if (!text) return null;

  // 1. Tentative directe
  try { return JSON.parse(text.trim()); } catch {}

  // 2. Retire les blocs markdown ```json ... ```
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(stripped); } catch {}

  // 3. Extrait le premier bloc { ... } complet
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;

  try { return JSON.parse(match[0]); } catch {}

  // 4. Répare un JSON tronqué
  let repaired = match[0];
  const openStr = (repaired.match(/(?<!\\)"/g) || []).length % 2;
  if (openStr === 1) repaired += '"';
  const opens  = (repaired.match(/\{/g) || []).length;
  const closes = (repaired.match(/\}/g) || []).length;
  for (let i = 0; i < opens - closes; i++) repaired += "}";
  try { return JSON.parse(repaired); } catch {}

  return null;
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 1 — Vision + OCR intégré (Gemini fait les deux)
// ════════════════════════════════════════════════════════════════════════
async function recognizeProduct(base64Images) {
  const imageParts = base64Images.slice(0, 3).map((b64) => ({
    inline_data: { mime_type: "image/jpeg", data: b64 },
  }));

  const payload = {
    contents: [{
      parts: [
        ...imageParts,
        {
          text: `Tu es un expert en identification d'objets d'occasion, aussi précis que Google Lens.
Analyse ces photos (face, étiquette, 3/4, usures).

Lis TOUT le texte visible : marques, modèles, références, étiquettes prix, tailles, codes.

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks :
{
  "productName": "nom précis et complet (ex: Nike Air Max 90 Blanc Taille 42)",
  "brand": "marque exacte ou null",
  "model": "modèle exact ou null",
  "category": "catégorie (ex: Chaussures, Vélo, Console, Livre...)",
  "condition": "excellent|bon|passable|mauvais",
  "visibleText": "tout le texte lu sur l'objet",
  "searchQuery": "requête optimisée pour LeBonCoin eBay FR (max 6 mots)",
  "suggestions": ["variante 1", "variante 2", "variante 3"],
  "confidence": 0.95
}`,
        },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 400,
    },
  };

  const text = await callGemini(payload);
  console.log("🔍 VISION RAW:", text?.substring(0, 300));

  if (!text) return _fallbackProduct();

  const obj = extractJSON(text);
  if (!obj || !obj.productName) {
    console.warn("⚠️  JSON Vision invalide, fallback");
    return _fallbackProduct();
  }

  obj.searchQuery = obj.searchQuery
    || [obj.brand, obj.model, obj.productName].filter(Boolean).join(" ").substring(0, 60);

  return obj;
}

function _fallbackProduct() {
  return {
    productName: "Objet occasion",
    brand: null, model: null,
    category: "Divers", condition: "bon",
    visibleText: "",
    searchQuery: "objet occasion",
    suggestions: ["Objet occasion", "Article d'occasion", "Produit reconditionné"],
    confidence: 0.2,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2A — eBay
// ════════════════════════════════════════════════════════════════════════
let _ebayToken = null;

async function getEbayToken() {
  if (_ebayToken && _ebayToken.exp > Date.now()) return _ebayToken.val;
  if (!EBAY_APP_ID || !EBAY_CERT) return null;
  try {
    const creds = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT}`).toString("base64");
    const res   = await axios.post(
      "https://api.ebay.com/identity/v1/oauth2/token",
      "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
      {
        headers: {
          Authorization: `Basic ${creds}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        timeout: 8000,
      }
    );
    _ebayToken = {
      val: res.data.access_token,
      exp: Date.now() + res.data.expires_in * 1000 - 60000,
    };
    return _ebayToken.val;
  } catch (e) {
    console.warn("⚠️  eBay token:", e.message);
    return null;
  }
}

async function getEbayPrices(query) {
  const key = `ebay:${query}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    const token = await getEbayToken();
    if (!token) return null;
    const res = await axios.get(
      "https://api.ebay.com/buy/browse/v1/item_summary/search",
      {
        params: { q: query, limit: 20, sort: "price" },
        headers: {
          Authorization: `Bearer ${token}`,
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR",
        },
        timeout: 8000,
      }
    );
    const prices = (res.data.itemSummaries || [])
      .map((i) => parseFloat(i.price?.value))
      .filter((p) => p > 0 && p < 100000)
      .sort((a, b) => a - b);
    if (!prices.length) return null;
    const result = {
      min:    Math.round(prices[Math.floor(prices.length * 0.25)]),
      max:    Math.round(prices[Math.floor(prices.length * 0.75)]),
      count:  prices.length, source: "ebay",
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("⚠️  eBay:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2B — LeBonCoin scraping
// ════════════════════════════════════════════════════════════════════════
async function getLeboncoinPrices(query) {
  const key = `lbc:${query}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    await sleep(800);
    const url = `https://www.leboncoin.fr/recherche?text=${encodeURIComponent(query)}&sort=time`;
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
        "Accept-Language": "fr-FR,fr;q=0.9",
      },
      timeout: 12000,
    });
    const $      = cheerio.load(data);
    const prices = [];
    $("[data-qa-id='aditem_price']").each((_, el) => {
      const p = parseInt($(el).text().replace(/[^\d]/g, ""), 10);
      if (p > 0 && p < 100000) prices.push(p);
    });
    if (!prices.length) return null;
    prices.sort((a, b) => a - b);
    const lo  = Math.floor(prices.length * 0.2);
    const hi  = Math.floor(prices.length * 0.8);
    const mid = prices.slice(lo, hi);
    const result = {
      min: mid[0] ?? prices[0],
      max: mid[mid.length - 1] ?? prices[prices.length - 1],
      count: prices.length, source: "lbc",
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("⚠️  LBC:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2C — Vinted scraping
// ════════════════════════════════════════════════════════════════════════
async function getVintedPrices(query) {
  const key = `vinted:${query}`;
  const hit = cache.get(key);
  if (hit) return hit;
  try {
    await sleep(1400);
    const url = `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}&order=newest_first`;
    const { data } = await axios.get(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
        "Accept-Language": "fr-FR,fr;q=0.9",
        Referer: "https://www.vinted.fr/",
      },
      timeout: 12000,
    });
    const $      = cheerio.load(data);
    const prices = [];
    $("[data-testid='item-price'], [class*='price']").each((_, el) => {
      const txt = $(el).text().replace(/[^\d,\.]/g, "").replace(",", ".");
      const p   = parseFloat(txt);
      if (p > 0 && p < 100000) prices.push(Math.round(p));
    });
    if (!prices.length) return null;
    prices.sort((a, b) => a - b);
    const lo  = Math.floor(prices.length * 0.2);
    const hi  = Math.floor(prices.length * 0.8);
    const mid = prices.slice(lo, hi);
    const result = {
      min: mid[0] ?? prices[0],
      max: mid[mid.length - 1] ?? prices[prices.length - 1],
      count: prices.length, source: "vinted",
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("⚠️  Vinted:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 3 — Décision + génération annonce
// ════════════════════════════════════════════════════════════════════════
async function generateDecision(product, prices) {
  const payload = {
    contents: [{
      parts: [{
        text: `Tu es un expert en vente d'objets d'occasion en France.
Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks.

Produit     : ${product.productName}
Marque      : ${product.brand || "inconnue"}
Modèle      : ${product.model || "inconnu"}
État estimé : ${product.condition}
Texte lu    : ${product.visibleText || "(aucun)"}
Prix marché : ${JSON.stringify(prices)}

Règles :
• credible = false  si prix médian < 15 € OU estimatedDays > 50
• credible = true   sinon

{
  "credible": true,
  "priceMin": 35,
  "priceMax": 45,
  "suggestedPrice": 42,
  "estimatedDays": 17,
  "platform": "Leboncoin",
  "title": "Titre prêt à coller (max 70 car.)",
  "description": "Description 3-5 phrases naturelles",
  "negotiationTip": "Conseil négo 1-2 phrases",
  "photoTip": "Conseil photo 1-2 phrases",
  "reason": "Explication si pas crédible sinon null"
}`,
      }],
    }],
    generationConfig: { temperature: 0.3, maxOutputTokens: 600 },
  };

  const text = await callGemini(payload);
  console.log("🧠 DECISION RAW:", text?.substring(0, 200));
  if (!text) return _fallbackDecision(product);
  return extractJSON(text) || _fallbackDecision(product);
}

function _fallbackDecision(p) {
  return {
    credible: false,
    priceMin: 5, priceMax: 20, suggestedPrice: 12,
    estimatedDays: 30, platform: "Vinted",
    title: p.productName,
    description: "Objet d'occasion en état correct.",
    negotiationTip: "Prix ferme recommandé.",
    photoTip: "Photographiez sur fond blanc.",
    reason: "Données insuffisantes pour une estimation précise.",
  };
}

// ════════════════════════════════════════════════════════════════════════
//  POST /analyze
// ════════════════════════════════════════════════════════════════════════
app.post("/analyze", async (req, res) => {
  const t0 = Date.now();
  try {
    const { images } = req.body;
    if (!Array.isArray(images) || !images.length) {
      return res.status(400).json({ error: "images[] manquant" });
    }
    console.log(`\n[${new Date().toISOString()}] 📸 ${images.length} photo(s)`);

    const product = await recognizeProduct(images);
    console.log(`✅ "${product.productName}" conf:${product.confidence}`);
    console.log(`📝 texte: "${product.visibleText}"`);
    console.log(`🔎 query: "${product.searchQuery}"`);

    const query = product.searchQuery;
    const [ebay, lbc, vinted] = await Promise.all([
      getEbayPrices(query),
      getLeboncoinPrices(query),
      getVintedPrices(query),
    ]);
    console.log(`💰 eBay:${JSON.stringify(ebay)} LBC:${JSON.stringify(lbc)} Vinted:${JSON.stringify(vinted)}`);

    const decision = await generateDecision(product, { ebay, lbc, vinted });
    console.log(`🧠 ${decision.credible ? "CRÉDIBLE ✅" : "PAS CRÉDIBLE ❌"} — ${Date.now() - t0}ms`);

    return res.json({
      credible:       decision.credible,
      productName:    product.productName,
      brand:          product.brand    ?? null,
      condition:      product.condition ?? null,
      suggestions:    product.suggestions ?? [],
      priceRange:     `${decision.priceMin} € – ${decision.priceMax} €`,
      suggestedPrice: `${decision.suggestedPrice} €`,
      timeRange:      `~${decision.estimatedDays} jours`,
      platform:       decision.platform,
      title:          decision.title,
      description:    decision.description,
      negotiationTip: decision.negotiationTip,
      photoTip:       decision.photoTip,
      reason:         decision.reason ?? null,
    });
  } catch (err) {
    console.error("❌ /analyze:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

app.get("/health", (_, res) => res.json({ status: "ok", ts: Date.now() }));

// Keep-alive Render gratuit (dort après 15min)
setInterval(async () => {
  try {
    await axios.get("https://cashizi-backend.onrender.com/health", { timeout: 5000 });
    console.log(`[${new Date().toISOString()}] 🏓 keep-alive`);
  } catch (_) {}
}, 14 * 60 * 1000);

app.listen(PORT, () => console.log(`🚀 Cashizi — port ${PORT}`));