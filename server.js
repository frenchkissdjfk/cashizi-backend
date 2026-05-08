const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const NodeCache = require("node-cache");

const app = express();
const PORT = process.env.PORT || 3000; 

const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json({ limit: "15mb" }));

// ── Clés API ──────────────────────────────────
const GEMINI_KEY = process.env.GEMINI_KEY || "AIzaSyBmm0uDpnppZdwWR-_Ff42rN1_It7eanqQ";
const EBAY_APP_ID = process.env.EBAY_APP_ID || "ETOURNEA-Cashizi-PRD-77b75c3f4-55f7796f";
const EBAY_CERT = process.env.EBAY_CERT || "PRD-7b75c3f4ebba-8834-4dd2-affd-98d4";

const BROWSER_HEADERS = {
    "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
    "Accept-Language": "fr-FR,fr;q=0.9",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Encoding": "gzip, deflate, br",
    "Connection": "keep-alive",
};

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- RECOGNITION ---
async function recognizeProduct(base64Images) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`;
    const imageParts = base64Images.slice(0, 3).map((b64) => ({
        inline_data: { mime_type: "image/jpeg", data: b64 },
    }));

    const body = {
        contents: [{
            parts: [
                ...imageParts,
                { text: `Tu es un expert en estimation. Réponds UNIQUEMENT en JSON : {"productName": "...", "brand": "...", "model": "...", "condition": "...", "category": "...", "suggestions": [], "confidence": 0.0}` },
            ],
        }],
    };

    const resp = await axios.post(url, body, { timeout: 20000 });
    const text = resp.data.candidates[0].content.parts[0].text;
    const clean = text.replace(/```json|```/g, "").trim();
    return JSON.parse(clean);
}

// --- EBAY ---
let _ebayTokenCache = null;
async function getEbayToken() {
    if (_ebayTokenCache && _ebayTokenCache.expires > Date.now()) return _ebayTokenCache.token;
    const creds = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT}`).toString("base64");
    const resp = await axios.post("https://api.ebay.com/identity/v1/oauth2/token", "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope", {
        headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" },
    });
    _ebayTokenCache = { token: resp.data.access_token, expires: Date.now() + resp.data.expires_in * 1000 - 60000 };
    return _ebayTokenCache.token;
}

async function getEbayPrices(query) {
    try {
        const token = await getEbayToken();
        const resp = await axios.get("https://api.ebay.com/buy/browse/v1/item_summary/search", {
            params: { q: query, limit: 20, "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR" },
            headers: { Authorization: `Bearer ${token}` },
        });
        const prices = (resp.data.itemSummaries || []).map(i => parseFloat(i.price.value)).filter(p => p > 0).sort((a,b)=>a-b);
        if (!prices.length) return null;
        return { min: Math.round(prices[0]), max: Math.round(prices[prices.length-1]), count: prices.length };
    } catch (e) { return null; }
}

// --- LBC ---
async function scrapeLeboncoin(query) {
    try {
        await sleep(1000);
        const { data } = await axios.get(`https://www.leboncoin.fr/recherche?text=${encodeURIComponent(query)}`, { headers: BROWSER_HEADERS });
        const $ = cheerio.load(data);
        const prices = [];
        $("[data-qa-id='aditem_price']").each((_, el) => {
            const p = parseInt($(el).text().replace(/[^\d]/g, ""));
            if (p) prices.push(p);
        });
        if (!prices.length) return null;
        return { min: Math.min(...prices), max: Math.max(...prices), count: prices.length };
    } catch (e) { return null; }
}

// --- VINTED ---
async function scrapeVinted(query) {
    try {
        await sleep(1500);
        const { data } = await axios.get(`https://www.vinted.fr/catalog?search_text=${encodeURIComponent(query)}`, { headers: BROWSER_HEADERS });
        const $ = cheerio.load(data);
        const prices = [];
        $("[data-testid='item-price']").each((_, el) => {
            const p = parseFloat($(el).text().replace(/[^\d,\.]/g, "").replace(",", "."));
            if (p) prices.push(p);
        });
        if (!prices.length) return null;
        return { min: Math.min(...prices), max: Math.max(...prices), count: prices.length };
    } catch (e) { return null; }
}

// --- DECISION ---
async function generateDecision(productInfo, priceData) {
    try {
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${GEMINI_KEY}`;
        const body = {
            contents: [{
                parts: [{ text: `Expert vente France. Réponds UNIQUEMENT JSON: {"credible": true, "priceMin": 0, "priceMax": 0, "suggestedPrice": 0, "estimatedDays": 0, "platform": "...", "title": "...", "description": "...", "negotiationTip": "...", "photoTip": "...", "reason": null}. Data: ${productInfo.productName}, Prices: ${JSON.stringify(priceData)}` }]
            }]
        };

        const resp = await axios.post(url, body, { timeout: 20000 });
        let text = resp.data.candidates[0].content.parts[0].text;
        
        // Nettoyage sans retour à la ligne sauvage
        const cleaned = text.replace(/```json/g, "").replace(/
```/g, "").trim();
        
        return JSON.parse(cleaned);
    } catch (error) {
        console.error("Erreur Gemini ou Parsing:", error);
        throw error;
    }
}

// --- ENDPOINTS ---
app.get("/", (req, res) => res.send("Serveur Cashizi opérationnel !"));

app.post("/analyze", async (req, res) => {
    try {
        const { images } = req.body;
        const productInfo = await recognizeProduct(images);
        const query = `${productInfo.brand || ""} ${productInfo.productName}`;
        const [ebay, lbc, vinted] = await Promise.all([getEbayPrices(query), scrapeLeboncoin(query), scrapeVinted(query)]);
        const decision = await generateDecision(productInfo, { ebay, lbc, vinted });
        res.json({ ...decision, productName: productInfo.productName });
    } catch (err) {
        console.error("Erreur Backend:", err);
        res.status(500).json({ error: err.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Cashizi en ligne sur le port ${PORT}`));