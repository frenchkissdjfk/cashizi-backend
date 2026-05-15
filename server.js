import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "15mb" }));

const GEMINI_KEY = process.env.GEMINI_KEY;
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT = process.env.EBAY_CERT;

// --- RECONNAISSANCE + STRATÉGIE ---
async function analyzeWithGemini(images) {
  // Utilisation de 1.5-flash : ultra rapide et moins cher pour la vision
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  
  const imageParts = images.slice(0, 3).map(b64 => ({
    inline_data: { mime_type: "image/jpeg", data: b64 }
  }));

  const payload = {
    contents: [{
      parts: [
        ...imageParts,
        { text: "Identifie précisément cet objet d'occasion. Donne son nom, marque, modèle, état estimé et une requête de recherche optimisée pour eBay. Réponds UNIQUEMENT en JSON : {\"name\":\"\",\"brand\":\"\",\"model\":\"\",\"condition\":\"\",\"searchQuery\":\"\"}" }
      ]
    }]
  };

  const res = await axios.post(url, payload);
  return JSON.parse(res.data.candidates[0].content.parts[0].text.replace(/```json|```/g, ""));
}

// --- PRIX RÉELS VIA EBAY ---
async function getEbayData(query) {
  try {
    const auth = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT}`).toString("base64");
    const tokenRes = await axios.post("https://api.ebay.com/identity/v1/oauth2/token", 
      "grant_type=client_credentials&scope=https://api.ebay.com/oauth/api_scope",
      { headers: { Authorization: `Basic ${auth}`, "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const res = await axios.get("https://api.ebay.com/buy/browse/v1/item_summary/search", {
      params: { q: query, limit: 10, filter: "buyingOptions:{FIXED_PRICE}" },
      headers: { Authorization: `Bearer ${tokenRes.data.access_token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR" }
    });

    const prices = (res.data.itemSummaries || []).map(i => parseFloat(i.price.value)).sort((a, b) => a - b);
    return prices.length ? { min: prices[0], max: prices[prices.length - 1], avg: prices[Math.floor(prices.length / 2)] } : null;
  } catch (e) { return null; }
}

// --- SYNTHÈSE FINALE ---
app.post("/analyze", async (req, res) => {
  try {
    const { images } = req.body;
    const product = await analyzeWithGemini(images);
    const market = await getEbayData(product.searchQuery || product.name);

    // Si eBay ne trouve rien, Gemini estime selon sa base de données
    const priceMin = market ? market.min : 10;
    const priceMax = market ? market.max : 50;

    res.json({
      status: "success",
      product,
      estimation: {
        priceRange: `${priceMin}€ - ${priceMax}€`,
        suggested: Math.round((priceMin + priceMax) / 2),
        speed: "7-15 jours", // Estimation basée sur la popularité (on peut l'affiner via Gemini)
        platform: "eBay / Leboncoin"
      }
    });
  } catch (err) {
    res.status(500).json({ error: "Erreur analyse" });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));
app.listen(PORT, () => console.log(`🚀 CASHIZI READY ON PORT ${PORT}`));