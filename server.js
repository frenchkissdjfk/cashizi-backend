const express = require("express");
const axios = require("axios");
const cheerio = require("cheerio");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json({ limit: "15mb" }));

const GEMINI_KEY = process.env.GEMINI_KEY || "AIzaSyBmm0uDpnppZdwWR-_Ff42rN1_It7eanqQ";
const EBAY_APP_ID = process.env.EBAY_APP_ID || "ETOURNEA-Cashizi-PRD-77b75c3f4-55f7796f";
const EBAY_CERT = process.env.EBAY_CERT || "PRD-7b75c3f4ebba-8834-4dd2-affd-98d4";

const BROWSER_HEADERS = { "User-Agent": "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1" };

async function recognizeProduct(images) {
    const url = `[https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=$){GEMINI_KEY}`;
    const body = { contents: [{ parts: [...images.slice(0, 3).map(b => ({ inline_data: { mime_type: "image/jpeg", data: b } })), { text: "Réponds UNIQUEMENT avec l'objet JSON brut, sans balises markdown : {\"productName\": \"...\", \"brand\": \"...\", \"model\": \"...\", \"condition\": \"...\", \"category\": \"...\", \"suggestions\": [], \"confidence\": 0.0}" }] }] };
    const resp = await axios.post(url, body);
    return JSON.parse(resp.data.candidates[0].content.parts[0].text.trim());
}

async function getEbayPrices(q) {
    try {
        const creds = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT}`).toString("base64");
        const tResp = await axios.post("[https://api.ebay.com/identity/v1/oauth2/token](https://api.ebay.com/identity/v1/oauth2/token)", "grant_type=client_credentials&scope=https%3A%2F%2Fapi.ebay.com%2Foauth%2Fapi_scope", { headers: { Authorization: `Basic ${creds}`, "Content-Type": "application/x-www-form-urlencoded" } });
        const resp = await axios.get("[https://api.ebay.com/buy/browse/v1/item_summary/search](https://api.ebay.com/buy/browse/v1/item_summary/search)", { params: { q, limit: 10 }, headers: { Authorization: `Bearer ${tResp.data.access_token}`, "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR" } });
        const prices = (resp.data.itemSummaries || []).map(i => parseFloat(i.price.value)).filter(p => p > 0).sort((a,b)=>a-b);
        return prices.length ? { min: Math.round(prices[0]), max: Math.round(prices[prices.length-1]), count: prices.length } : null;
    } catch { return null; }
}

async function generateDecision(info, prices) {
    const url = `[https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=$](https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=$){GEMINI_KEY}`;
    const prompt = `Expert France. Réponds UNIQUEMENT le JSON brut: {"credible":true,"priceMin":0,"priceMax":0,"suggestedPrice":0,"estimatedDays":0,"platform":"...","title":"...","description":"...","negotiationTip":"...","photoTip":"...","reason":null}. Produit: ${info.productName}, Prix: ${JSON.stringify(prices)}`;
    const resp = await axios.post(url, { contents: [{ parts: [{ text: prompt }] }] });
    return JSON.parse(resp.data.candidates[0].content.parts[0].text.trim());
}

app.get("/", (req, res) => res.send("Cashizi Live"));
app.post("/analyze", async (req, res) => {
    try {
        const info = await recognizeProduct(req.body.images);
        const pEbay = await getEbayPrices(`${info.brand} ${info.productName}`);
        const decision = await generateDecision(info, { ebay: pEbay });
        res.json({ ...decision, productName: info.productName });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));