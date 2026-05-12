// ═══════════════════════════════════════════════════════════════════════
//  CASHIZI — Backend production
//  Déploiement : Render (https://cashizi-backend.onrender.com)
//  Port        : 10000 (requis par Render)
//  Modèle IA   : gemini-2.0-flash (alias "latest")
//
//  Variables d'environnement à configurer dans Render :
//    GEMINI_KEY   → votre clé Gemini API
//    EBAY_APP_ID  → App ID eBay
//    EBAY_CERT    → Cert ID eBay
// ═══════════════════════════════════════════════════════════════════════

import express   from "express";
import axios     from "axios";
import * as cheerio from "cheerio";
import cors      from "cors";
import NodeCache from "node-cache";

const app   = express();
const PORT  = process.env.PORT || 10000;
const cache = new NodeCache({ stdTTL: 3600 });

// ── CORS : autorise uniquement les appels légitimes ───────────────────
app.use(cors({
  origin: "*", // En prod vous pouvez restreindre à votre domaine Flutter
  methods: ["GET", "POST"],
}));
app.use(express.json({ limit: "15mb" }));

// ── Variables d'environnement (jamais en dur) ─────────────────────────
const GEMINI_KEY  = process.env.GEMINI_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT   = process.env.EBAY_CERT;

// Vérifie les clés au démarrage
if (!GEMINI_KEY) {
  console.error("❌ GEMINI_KEY manquante — ajoutez-la dans les variables Render");
  process.exit(1);
}

const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4 Mobile/15E148 Safari/604.1",
  "Accept-Language": "fr-FR,fr;q=0.9",
  "Accept":
    "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════
//  STEP 1 — Gemini Flash (latest) Vision : reconnaissance produit
// ════════════════════════════════════════════════════════════════════════
async function recognizeProduct(base64Images) {
  // gemini-2.0-flash-latest = modèle le plus récent et le plus rapide
  const model = "gemini-2.0-flash";
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

  const imageParts = base64Images.slice(0, 3).map((b64) => ({
    inline_data: { mime_type: "image/jpeg", data: b64 },
  }));

  const body = {
    contents: [{
      parts: [
        ...imageParts,
        {
          text: `Tu es un expert en estimation de produits d'occasion en France.
Analyse ces photos (jusqu'à 3 angles du même objet) et réponds UNIQUEMENT en JSON valide, sans markdown ni backticks.
Format attendu :
{
  "productName": "nom précis du produit",
  "brand": "marque si visible sinon null",
  "model": "modèle si visible sinon null",
  "condition": "excellent|bon|passable|mauvais",
  "category": "catégorie principale",
  "suggestions": ["variante 1", "variante 2", "variante 3"],
  "confidence": 0.95
}`,
        },
      ],
    }],
    generationConfig: {
      temperature: 0.2,
      maxOutputTokens: 512,
    },
  };

  const resp  = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 25000,
  });
  const text  = resp.data.candidates[0].content.parts[0].text;
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2A — eBay API : prix marché réels
// ════════════════════════════════════════════════════════════════════════
let _ebayTokenCache = null;

async function getEbayToken() {
  if (_ebayTokenCache && _ebayTokenCache.expires > Date.now()) {
    return _ebayTokenCache.token;
  }
  if (!EBAY_APP_ID || !EBAY_CERT) {
    throw new Error("EBAY_APP_ID ou EBAY_CERT manquant");
  }
  const creds = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT}`).toString("base64");
  const resp  = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    {
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      timeout: 10000,
    }
  );
  _ebayTokenCache = {
    token:   resp.data.access_token,
    expires: Date.now() + resp.data.expires_in * 1000 - 60000,
  };
  return _ebayTokenCache.token;
}

async function getEbayPrices(query) {
  const key    = `ebay_${query}`;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    const token = await getEbayToken();
    const resp  = await axios.get(
      "https://api.ebay.com/buy/browse/v1/item_summary/search",
      {
        params: {
          q: query,
          filter: "conditionIds:{1000|1500|2000|2500|3000},buyingOptions:{FIXED_PRICE}",
          sort: "price", limit: 20,
        },
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
          "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR",
        },
        timeout: 10000,
      }
    );
    const items  = resp.data.itemSummaries || [];
    const prices = items
      .map((i) => parseFloat(i.price?.value || 0))
      .filter((p) => p > 0)
      .sort((a, b) => a - b);
    if (!prices.length) return null;
    const q1     = prices[Math.floor(prices.length * 0.25)];
    const q3     = prices[Math.floor(prices.length * 0.75)];
    const result = { min: Math.round(q1), max: Math.round(q3), count: prices.length };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("eBay error:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2B — Scraping Leboncoin
// ════════════════════════════════════════════════════════════════════════
async function scrapeLeboncoin(query) {
  const key    = `lbc_${query}`;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    await sleep(1200);
    const url = `https://www.leboncoin.fr/recherche?text=${encodeURIComponent(query)}&sort=time&order=desc`;
    const { data } = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 12000,
    });
    const $      = cheerio.load(data);
    const prices = [];
    $("[data-qa-id='aditem_container']").each((_, el) => {
      const txt   = $(el).find("[data-qa-id='aditem_price']").text().trim();
      const match = txt.match(/[\d\s]+/);
      if (match) {
        const p = parseInt(match[0].replace(/\s/g, ""), 10);
        if (p > 0 && p < 50000) prices.push(p);
      }
    });
    if (!prices.length) return null;
    prices.sort((a, b) => a - b);
    const mid    = prices.slice(
      Math.floor(prices.length * 0.2),
      Math.floor(prices.length * 0.8)
    );
    if (!mid.length) return null;
    const avg    = Math.round(mid.reduce((a, b) => a + b, 0) / mid.length);
    const result = {
      min: mid[0], max: mid[mid.length - 1], avg, count: prices.length,
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("LBC error:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2C — Scraping Vinted
// ════════════════════════════════════════════════════════════════════════
async function scrapeVinted(query) {
  const key    = `vinted_${query}`;
  const cached = cache.get(key);
  if (cached) return cached;
  try {
    await sleep(1800);
    const url = `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}&order=newest_first`;
    const { data } = await axios.get(url, {
      headers: { ...BROWSER_HEADERS, Referer: "https://www.vinted.fr/" },
      timeout: 12000,
    });
    const $      = cheerio.load(data);
    const prices = [];
    $("[data-testid='item-price'], [class*='price']").each((_, el) => {
      const txt = $(el).text().replace(/[^\d,\.]/g, "").replace(",", ".");
      const p   = parseFloat(txt);
      if (p > 0 && p < 50000) prices.push(Math.round(p));
    });
    if (!prices.length) return null;
    prices.sort((a, b) => a - b);
    const mid    = prices.slice(
      Math.floor(prices.length * 0.2),
      Math.floor(prices.length * 0.8)
    );
    if (!mid.length) return null;
    const avg    = Math.round(mid.reduce((a, b) => a + b, 0) / mid.length);
    const result = {
      min: mid[0], max: mid[mid.length - 1], avg, count: prices.length,
    };
    cache.set(key, result);
    return result;
  } catch (e) {
    console.warn("Vinted error:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 3 — Gemini Flash : décision + génération annonce complète
// ════════════════════════════════════════════════════════════════════════
async function generateDecision(productInfo, priceData) {
  const model = "gemini-2.0-flash";
  const url   = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;

  const body = {
    contents: [{
      parts: [{
        text: `Tu es un expert en vente d'objets d'occasion en France.
Réponds UNIQUEMENT en JSON valide, sans markdown ni backticks.

Produit     : ${productInfo.productName}
Marque      : ${productInfo.brand || "inconnue"}
Modèle      : ${productInfo.model || "inconnu"}
État estimé : ${productInfo.condition}
Prix marché : ${JSON.stringify({
  ebay:      priceData.ebay,
  leboncoin: priceData.lbc,
  vinted:    priceData.vinted,
})}

Règles de décision :
• credible = false  si prix médian toutes sources < 15 € OU si estimatedDays > 50
• credible = true   sinon

Format JSON attendu (respecte-le exactement) :
{
  "credible": true,
  "priceMin": 35,
  "priceMax": 45,
  "suggestedPrice": 42,
  "estimatedDays": 17,
  "platform": "Leboncoin",
  "title": "Titre prêt à copier-coller (max 70 caractères)",
  "description": "Description complète prête à coller (3-5 phrases naturelles, ton vendeur français)",
  "negotiationTip": "Conseil de négociation personnalisé (1-2 phrases)",
  "photoTip": "Conseil photo pratique pour cette catégorie (1-2 phrases)",
  "reason": "Explication courte si pas crédible, sinon null"
}`,
      }],
    }],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 1024,
    },
  };

  const resp  = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 25000,
  });
  const text  = resp.data.candidates[0].content.parts[0].text;
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ════════════════════════════════════════════════════════════════════════
//  ENDPOINT PRINCIPAL  POST /analyze
//  Body JSON : { "images": ["base64...", "base64...", "base64..."] }
// ════════════════════════════════════════════════════════════════════════
app.get("/", (req, res) => res.send("Serveur Cashizi OK"));
app.post("/analyze", async (req, res) => {
  const start = Date.now();
  try {
    const { images } = req.body;
    if (!images || !Array.isArray(images) || images.length === 0) {
      return res.status(400).json({ error: "images manquantes ou invalides" });
    }

    console.log(`[${new Date().toISOString()}] 📸 Analyse — ${images.length} photo(s)`);

    // 1. Reconnaissance produit via Gemini Vision
    const productInfo = await recognizeProduct(images);
    console.log(`  ✅ Produit : ${productInfo.productName} (confiance : ${productInfo.confidence})`);

    const query = [productInfo.brand, productInfo.productName]
      .filter(Boolean).join(" ");

    // 2. Collecte des prix en parallèle
    const [ebay, lbc, vinted] = await Promise.all([
      getEbayPrices(query),
      scrapeLeboncoin(query),
      scrapeVinted(query),
    ]);
    console.log(`  💰 eBay: ${JSON.stringify(ebay)} | LBC: ${JSON.stringify(lbc)} | Vinted: ${JSON.stringify(vinted)}`);

    // 3. Décision + génération annonce via Gemini text
    const decision = await generateDecision(productInfo, { ebay, lbc, vinted });
    console.log(`  🧠 ${decision.credible ? "CRÉDIBLE ✅" : "PAS CRÉDIBLE ❌"} — ${Date.now() - start}ms`);

    res.json({
      credible:       decision.credible,
      productName:    productInfo.productName,
      brand:          productInfo.brand    || null,
      condition:      productInfo.condition || null,
      suggestions:    productInfo.suggestions || [],
      priceRange:     `${decision.priceMin} € – ${decision.priceMax} €`,
      suggestedPrice: `${decision.suggestedPrice} €`,
      timeRange:      `~${decision.estimatedDays} jours`,
      platform:       decision.platform,
      title:          decision.title,
      description:    decision.description,
      negotiationTip: decision.negotiationTip,
      photoTip:       decision.photoTip,
      reason:         decision.reason || null,
    });
  } catch (err) {
    console.error(`[${new Date().toISOString()}] ❌ /analyze : ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ── Health check (Render l'utilise pour vérifier que le service tourne)
app.get("/health", (_, res) => res.json({ status: "ok", ts: Date.now() }));

// ── Keep-alive : Render met le service en veille après 15min sur le plan
//   gratuit. Ce ping toutes les 14min évite le cold start.
//   Désactivez si vous passez sur un plan payant Render.
setInterval(async () => {
  try {
    await axios.get("https://cashizi-backend.onrender.com/health", {
      timeout: 5000,
    });
    console.log(`[${new Date().toISOString()}] 🏓 keep-alive ok`);
  } catch (_) {}
}, 14 * 60 * 1000);

app.listen(PORT, () =>
  console.log(`🚀 Cashizi backend — port ${PORT} — ${new Date().toISOString()}`)
);