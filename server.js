// backend/server.js
// npm install express axios cheerio cors node-cache

import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import NodeCache from "node-cache";

const app  = express();
const PORT = 3000;
const cache = new NodeCache({ stdTTL: 3600 }); // cache 1h

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ── Clés ─────────────────────────────────────────────────────────────────
const GEMINI_KEY  = "AIzaSyBmm0uDpnppZdwWR-_Ff42rN1_It7eanqQ";
const EBAY_APP_ID = process.env.EBAY_APP_ID;

// ── Headers navigateur anti-bot ──────────────────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
    "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept-Language": "fr-FR,fr;q=0.9",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Encoding": "gzip, deflate, br",
  "Connection": "keep-alive",
};

// ── Délai anti-spam ──────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════
//  STEP 1 : Gemini Vision → reconnaissance produit
// ════════════════════════════════════════════════════════════════════════
async function recognizeProduct(base64Image) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

  const body = {
    contents: [
      {
        parts: [
          {
            inline_data: {
              mime_type: "image/jpeg",
              data: base64Image,
            },
          },
          {
            text: `Tu es un expert en estimation de produits d'occasion.
Analyse cette photo et réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks.
Format attendu :
{
  "productName": "nom précis du produit",
  "brand": "marque si visible",
  "condition": "excellent|bon|passable|mauvais",
  "category": "catégorie principale",
  "suggestions": ["variante 1", "variante 2", "variante 3"],
  "confidence": 0.0
}`,
          },
        ],
      },
    ],
  };

  const resp = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  const text = resp.data.candidates[0].content.parts[0].text;
  // Nettoie les éventuels backticks
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2A : eBay API → prix vendus réels
// ════════════════════════════════════════════════════════════════════════
async function getEbayPrices(query) {
  const cacheKey = `ebay_${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    const url = "https://api.ebay.com/buy/browse/v1/item_summary/search";
    const params = {
      q: query,
      filter: "conditionIds:{1000|1500|2000|2500|3000},buyingOptions:{FIXED_PRICE}",
      sort: "price",
      limit: 20,
      fieldgroups: "ASPECT_REFINEMENTS",
    };

    // Token OAuth eBay (Client Credentials)
    const token = await getEbayToken();

    const resp = await axios.get(url, {
      params,
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR",
      },
      timeout: 10000,
    });

    const items = resp.data.itemSummaries || [];
    const prices = items
      .map((i) => parseFloat(i.price?.value || 0))
      .filter((p) => p > 0)
      .sort((a, b) => a - b);

    if (prices.length === 0) return null;

    const q1 = prices[Math.floor(prices.length * 0.25)];
    const q3 = prices[Math.floor(prices.length * 0.75)];
    const result = { min: Math.round(q1), max: Math.round(q3), count: prices.length };
    cache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error("eBay error:", e.message);
    return null;
  }
}

// OAuth eBay
let ebayTokenCache = null;
async function getEbayToken() {
  if (ebayTokenCache && ebayTokenCache.expires > Date.now()) {
    return ebayTokenCache.token;
  }
  const CERT_ID = "PRD-7b75c3f4ebba-8834-4dd2-affd-98d4";
  const creds = Buffer.from(`${EBAY_APP_ID}:${CERT_ID}`).toString("base64");
  const resp = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope",
    {
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );
  ebayTokenCache = {
    token: resp.data.access_token,
    expires: Date.now() + resp.data.expires_in * 1000 - 60000,
  };
  return ebayTokenCache.token;
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2B : Scraping Leboncoin
// ════════════════════════════════════════════════════════════════════════
async function scrapeLeboncoin(query) {
  const cacheKey = `lbc_${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    await sleep(1500);
    const url = `https://www.leboncoin.fr/recherche?text=${encodeURIComponent(query)}&sort=time&order=desc`;
    const { data } = await axios.get(url, {
      headers: BROWSER_HEADERS,
      timeout: 12000,
    });

    const $ = cheerio.load(data);
    const prices = [];

    // Sélecteurs LBC (peuvent évoluer)
    $("[data-qa-id='aditem_container']").each((_, el) => {
      const priceText = $(el).find("[data-qa-id='aditem_price']").text().trim();
      const match = priceText.match(/[\d\s]+/);
      if (match) {
        const p = parseInt(match[0].replace(/\s/g, ""), 10);
        if (p > 0 && p < 50000) prices.push(p);
      }
    });

    // Fallback sélecteur alternatif
    if (prices.length === 0) {
      $("span[aria-label*='€'], span[aria-label*='euro']").each((_, el) => {
        const txt = $(el).text().replace(/[^\d]/g, "");
        const p = parseInt(txt, 10);
        if (p > 0 && p < 50000) prices.push(p);
      });
    }

    if (prices.length === 0) return null;

    prices.sort((a, b) => a - b);
    const mid = prices.slice(
      Math.floor(prices.length * 0.2),
      Math.floor(prices.length * 0.8)
    );
    const avg = Math.round(mid.reduce((a, b) => a + b, 0) / mid.length);
    const result = { min: mid[0] || prices[0], max: mid[mid.length - 1] || prices[prices.length - 1], avg, count: prices.length };
    cache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error("LBC scraping error:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 2C : Scraping Vinted
// ════════════════════════════════════════════════════════════════════════
async function scrapeVinted(query) {
  const cacheKey = `vinted_${query}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  try {
    await sleep(2000);
    const url = `https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}&order=newest_first`;
    const { data } = await axios.get(url, {
      headers: {
        ...BROWSER_HEADERS,
        "Referer": "https://www.vinted.fr/",
      },
      timeout: 12000,
    });

    const $ = cheerio.load(data);
    const prices = [];

    $("[data-testid='item-price'], .ItemBox_price__HiY3s, [class*='price']").each((_, el) => {
      const txt = $(el).text().replace(/[^\d,\.]/g, "").replace(",", ".");
      const p = parseFloat(txt);
      if (p > 0 && p < 50000) prices.push(Math.round(p));
    });

    if (prices.length === 0) return null;

    prices.sort((a, b) => a - b);
    const mid = prices.slice(
      Math.floor(prices.length * 0.2),
      Math.floor(prices.length * 0.8)
    );
    const avg = Math.round(mid.reduce((a, b) => a + b, 0) / (mid.length || 1));
    const result = { min: mid[0] || prices[0], max: mid[mid.length - 1] || prices[prices.length - 1], avg, count: prices.length };
    cache.set(cacheKey, result);
    return result;
  } catch (e) {
    console.error("Vinted scraping error:", e.message);
    return null;
  }
}

// ════════════════════════════════════════════════════════════════════════
//  STEP 3 : Gemini text → décision + annonce complète
// ════════════════════════════════════════════════════════════════════════
async function generateDecision(productInfo, priceData) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;

  const priceContext = JSON.stringify({
    ebay: priceData.ebay,
    leboncoin: priceData.lbc,
    vinted: priceData.vinted,
  });

  const body = {
    contents: [
      {
        parts: [
          {
            text: `Tu es un expert en vente d'objets d'occasion. Analyse ces données et réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks.

Produit : ${productInfo.productName}
Marque : ${productInfo.brand || "inconnue"}
État : ${productInfo.condition}
Données de prix marché : ${priceContext}

Calcule :
- Si les prix trouvés sont tous < 15€ OU si le temps de vente estimé > 45 jours → credible = false
- Sinon → credible = true

Format JSON attendu :
{
  "credible": true,
  "priceMin": 35,
  "priceMax": 45,
  "suggestedPrice": 42,
  "estimatedDays": 17,
  "platform": "Leboncoin",
  "title": "Titre de l'annonce prêt à copier",
  "description": "Description complète prête à copier (3-4 phrases)",
  "negotiationTip": "Conseil de négociation personnalisé",
  "photoTip": "Conseil photo pour maximiser les ventes",
  "reason": "Explication courte si pas crédible (sinon null)"
}`,
          },
        ],
      },
    ],
  };

  const resp = await axios.post(url, body, {
    headers: { "Content-Type": "application/json" },
    timeout: 15000,
  });

  const text = resp.data.candidates[0].content.parts[0].text;
  const clean = text.replace(/```json|```/g, "").trim();
  return JSON.parse(clean);
}

// ════════════════════════════════════════════════════════════════════════
//  ENDPOINT PRINCIPAL  POST /analyze
// ════════════════════════════════════════════════════════════════════════
app.post("/analyze", async (req, res) => {
  try {
    const { image } = req.body; // base64 JPEG

    if (!image) {
      return res.status(400).json({ error: "image manquante" });
    }

    console.log("📸 Analyse démarrée...");

    // 1. Reconnaissance produit via Gemini Vision
    const productInfo = await recognizeProduct(image);
    console.log("✅ Produit reconnu:", productInfo.productName);

    const query = productInfo.brand
      ? `${productInfo.brand} ${productInfo.productName}`
      : productInfo.productName;

    // 2. Collecte des prix (parallèle)
    const [ebay, lbc, vinted] = await Promise.all([
      getEbayPrices(query),
      scrapeLeboncoin(query),
      scrapeVinted(query),
    ]);

    console.log("💰 Prix — eBay:", ebay, "| LBC:", lbc, "| Vinted:", vinted);

    const priceData = { ebay, lbc, vinted };

    // 3. Décision + génération annonce via Gemini text
    const decision = await generateDecision(productInfo, priceData);
    console.log("🧠 Décision:", decision.credible ? "CRÉDIBLE" : "PAS CRÉDIBLE");

    // 4. Réponse finale
    res.json({
      credible: decision.credible,
      productName: productInfo.productName,
      brand: productInfo.brand,
      condition: productInfo.condition,
      suggestions: productInfo.suggestions,
      priceRange: `${decision.priceMin} € – ${decision.priceMax} €`,
      suggestedPrice: `${decision.suggestedPrice} €`,
      timeRange: `~${decision.estimatedDays} jours`,
      platform: decision.platform,
      title: decision.title,
      description: decision.description,
      negotiationTip: decision.negotiationTip,
      photoTip: decision.photoTip,
      reason: decision.reason || null,
      sources: {
        ebay: ebay ? `${ebay.count} annonces eBay` : null,
        lbc: lbc ? `${lbc.count} annonces LBC` : null,
        vinted: vinted ? `${vinted.count} annonces Vinted` : null,
      },
    });
  } catch (err) {
    console.error("❌ Erreur /analyze:", err.message);
    res.status(500).json({ error: err.message });
  }
});

// Health check
app.get("/health", (_, res) => res.json({ status: "ok" }));

app.listen(PORT, () =>
  console.log(`🚀 Cashizi backend → http://localhost:${PORT}`)
);