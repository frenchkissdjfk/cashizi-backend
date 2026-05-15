// ═══════════════════════════════════════════════════════════════════════
//  CASHIZI — Backend production
//  Render free tier compatible (512 MB RAM max)
//
//  Pourquoi pas Tesseract :
//  → Tesseract.js charge un modèle WASM de ~80 MB en RAM par appel,
//    ce qui fait dépasser le heap limit de Render gratuit (512 MB).
//  → Remplacé par : on envoie les 3 photos à Gemini Vision en lui
//    demandant AUSSI d'extraire tout texte visible (labels, étiquettes).
//    Résultat = meilleur qu'un OCR générique ET sans RAM supplémentaire.
//
//  Variables Render à configurer :
//    GEMINI_KEY  → AIza...
//    EBAY_APP_ID → ETOURNEA-Cashizi-PRD-...
//    EBAY_CERT   → PRD-...
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

// ── Modèles Gemini disponibles (fallback dans l'ordre) ────────────────
// gemini-2.0-flash = modèle stable le plus récent avec vision
// gemini-1.5-flash = fallback si quota 2.0 épuisé
const GEMINI_MODELS = ["gemini-2.0-flash", "gemini-1.5-flash"];

// ════════════════════════════════════════════════════════════════════════
//  UTILITAIRE : extraction JSON robuste
//  Gère les cas : backticks, JSON tronqué, texte parasite autour
// ════════════════════════════════════════════════════════════════════════
function extractJSON(text) {
  if (!text || typeof text !== "string") return null;

  // 1. Tentative directe
  try { return JSON.parse(text.trim()); } catch {}

  // 2. Retire les balises markdown ```json ... ```
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(stripped); } catch {}

  // 3. Extrait le premier bloc {...} complet
  const match = stripped.match(/\{[\s\S]*\}/);
  if (match) {
    try { return JSON.parse(match[0]); } catch {}

    // 4. Tente de réparer un JSON tronqué (dernière valeur non fermée)
    let repaired = match[0];
    // Compte les guillemets ouverts
    const openStrings = (repaired.match(/(?<!\\)"/g) || []).length % 2;
    if (openStrings === 1) repaired += '"';
    // Ferme les accolades/crochets manquants
    const opens = (repaired.match(/\{/g) || []).length;
    const closes = (repaired.match(/\}/g) || []).length;
    for (let i = 0; i < opens - closes; i++) repaired += "}";
    try { return JSON.parse(repaired); } catch {}
  }

  return null;
}

// ════════════════════════════════════════════════════════════════════════
//  APPEL GEMINI avec retry automatique sur les deux modèles
// ════════════════════════════════════════════════════════════════════════
async function callGemini(payload, timeoutMs = 28000) {
  for (const model of GEMINI_MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
    try {
      const res = await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: timeoutMs,
      });
      const candidate = res.data?.candidates?.[0];
      const text = candidate?.content?.parts?.[0]?.text ?? "";
      if (text.length > 5) return text; // succès
    } catch (err) {
      const status = err.response?.status;
      console.warn(`⚠️  Gemini ${model} → HTTP ${status || err.message}`);
      if (status === 503 || status === 429) {
        await sleep(1500);
        continue; // essaie le modèle suivant
      }
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 1 — Vision + OCR intégré : reconnaissance produit depuis photos
//
//  On demande à Gemini de faire les deux en une seule requête :
//  - Identifier l'objet (comme Google Lens)
//  - Lire tout texte visible (marque, modèle, référence, étiquette prix)
//  → Aucun OCR externe = zéro RAM supplémentaire
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
Analyse ces photos sous tous les angles (face, étiquette, 3/4, usures visibles).

Lis TOUT le texte visible sur l'objet : marques, modèles, références, codes-barres, étiquettes prix, numéros de série.

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, sans commentaire :
{
  "productName": "nom précis et complet du produit (ex: Nike Air Max 90 Blanc Taille 42)",
  "brand": "marque exacte ou null",
  "model": "modèle exact ou null",
  "category": "catégorie principale (ex: Chaussures, Vélo, Console, Livre...)",
  "condition": "excellent|bon|passable|mauvais",
  "visibleText": "tout le texte lu sur l'objet, séparé par des espaces",
  "searchQuery": "requête de recherche optimisée pour LeBonCoin et eBay FR (marque + modèle + type, max 6 mots)",
  "suggestions": ["variante 1", "variante 2", "variante 3"],
  "confidence": 0.95
}`
        },
      ],
    }],
    generationConfig: {
      temperature: 0.1,
      maxOutputTokens: 300,
    },
  };

  const text = await callGemini(payload);
  console.log("🔍 VISION RAW:", text?.substring(0, 200));

  if (!text || text.length < 20) {
    return _fallbackProduct();
  }

  const obj = extractJSON(text);
  if (!obj || !obj.productName) {
    console.warn("⚠️  extractJSON failed, using fallback");
    return _fallbackProduct();
  }

  // searchQuery = clé de recherche la plus précise possible
  obj.searchQuery = obj.searchQuery
    || [obj.brand, obj.model, obj.productName].filter(Boolean).join(" ").substring(0, 60);

  return obj;
}

function _fallbackProduct() {
  return {
    productName: "Objet occasion",
    brand: null, model: null,
    category: "Divers",
    condition: "bon",
    visibleText: "",
    searchQuery: "objet occasion",
    suggestions: ["Objet occasion", "Article d'occasion", "Produit reconditionné"],
    confidence: 0.2,
  };
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2A — eBay API : prix marché réels
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
      count:  prices.length,
      source: "ebay",
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("⚠️  eBay search:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2B — Scraping LeBonCoin
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
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
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
    const lo = Math.floor(prices.length * 0.2);
    const hi = Math.floor(prices.length * 0.8);
    const mid = prices.slice(lo, hi);

    const result = {
      min:    mid[0]              ?? prices[0],
      max:    mid[mid.length - 1] ?? prices[prices.length - 1],
      count:  prices.length,
      source: "lbc",
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("⚠️  LBC:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2C — Scraping Vinted
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
        "User-Agent":
          "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) AppleWebKit/605.1.15 Safari/604.1",
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
    const lo = Math.floor(prices.length * 0.2);
    const hi = Math.floor(prices.length * 0.8);
    const mid = prices.slice(lo, hi);

    const result = {
      min:    mid[0]              ?? prices[0],
      max:    mid[mid.length - 1] ?? prices[prices.length - 1],
      count:  prices.length,
      source: "vinted",
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("⚠️  Vinted:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 3 — Gemini text : décision + annonce complète
// ════════════════════════════════════════════════════════════════════════
async function generateDecision(productInfo, prices) {
  const payload = {
    contents: [{
      parts: [{
        text: `Tu es un expert en vente d'objets d'occasion en France.
Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks.

Produit     : ${productInfo.productName}
Marque      : ${productInfo.brand || "inconnue"}
Modèle      : ${productInfo.model || "inconnu"}
État estimé : ${productInfo.condition}
Texte lu    : ${productInfo.visibleText || "(aucun)"}
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
  "description": "Description complète 3-5 phrases naturelles",
  "negotiationTip": "Conseil négo 1-2 phrases",
  "photoTip": "Conseil photo pratique 1-2 phrases",
  "reason": "Explication courte si pas crédible, sinon null"
}`,
      }],
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 600,
    },
  };

  const text = await callGemini(payload);
  console.log("🧠 DECISION RAW:", text?.substring(0, 200));

  if (!text) return _fallbackDecision(productInfo);

  const obj = extractJSON(text);
  return obj || _fallbackDecision(productInfo);
}

function _fallbackDecision(p) {
  return {
    credible: false,
    priceMin: 5, priceMax: 20, suggestedPrice: 12,
    estimatedDays: 30,
    platform: "Vinted",
    title: p.productName,
    description: "Objet d'occasion en état correct. À récupérer sur place.",
    negotiationTip: "Prix ferme recommandé.",
    photoTip: "Photographiez sur fond blanc avec bonne lumière.",
    reason: "Données insuffisantes pour une estimation précise.",
  };
}

// ════════════════════════════════════════════════════════════════════════
//  ENDPOINT  POST /analyze
//  Body : { "images": ["base64jpeg", "base64jpeg", "base64jpeg"] }
// ════════════════════════════════════════════════════════════════════════
app.post("/analyze", async (req, res) => {
  const t0 = Date.now();
  try {
    const { images } = req.body;
    if (!Array.isArray(images) || !images.length) {
      return res.status(400).json({ error: "images[] manquant" });
    }

    console.log(`\n[${new Date().toISOString()}] 📸 ${images.length} photo(s)`);

    // 1. Vision : identification précise (inclut OCR via Gemini)
    const product = await recognizeProduct(images);
    console.log(`✅ "${product.productName}" (conf: ${product.confidence})`);
    console.log(`📝 texte lu: "${product.visibleText}"`);
    console.log(`🔎 query: "${product.searchQuery}"`);

    // 2. Prix marché en parallèle (utilise searchQuery optimisée)
    const query = product.searchQuery;
    const [ebay, lbc, vinted] = await Promise.all([
      getEbayPrices(query),
      getLeboncoinPrices(query),
      getVintedPrices(query),
    ]);
    console.log(`💰 eBay:${JSON.stringify(ebay)} LBC:${JSON.stringify(lbc)} Vinted:${JSON.stringify(vinted)}`);

    // 3. Décision + génération annonce
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

// ── Health check ──────────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", ts: Date.now() }));

// ── Keep-alive (Render gratuit dort après 15min) ──────────────────────
setInterval(async () => {
  try {
    await axios.get("https://cashizi-backend.onrender.com/health",
        { timeout: 5000 });
    console.log(`[${new Date().toISOString()}] 🏓 keep-alive`);
  } catch (_) {}
}, 14 * 60 * 1000);

app.listen(PORT, () =>
  console.log(`🚀 Cashizi backend — port ${PORT}`));