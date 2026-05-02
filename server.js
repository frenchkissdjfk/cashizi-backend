import express from "express";
import axios from "axios";
import * as cheerio from "cheerio";
import cors from "cors";
import NodeCache from "node-cache";
import dotenv from "dotenv";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;
const cache = new NodeCache({ stdTTL: 3600 });

app.use(cors());
app.use(express.json({ limit: "10mb" }));

// ── ENV KEYS ─────────────────────────────────────
const EBAY_APP_ID = process.env.EBAY_APP_ID;
const EBAY_CERT_ID = process.env.EBAY_CERT_ID;
const GEMINI_KEY = process.env.GEMINI_KEY;

// ── HEADERS ─────────────────────────────────────
const BROWSER_HEADERS = {
  "User-Agent":
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  "Accept-Language": "fr-FR,fr;q=0.9",
  Accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
};

// ── SLEEP ───────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ═══════════════════════════════════════════════
// GEMINI VISION
// ═══════════════════════════════════════════════
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
            text: `Analyse cette image et retourne UNIQUEMENT un JSON :
{
  "productName": "",
  "brand": "",
  "condition": "",
  "category": "",
  "confidence": 0
}`,
          },
        ],
      },
    ],
  };

  const resp = await axios.post(url, body);
  const text = resp.data.candidates[0].content.parts[0].text;
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

// ═══════════════════════════════════════════════
// EBAY TOKEN
// ═══════════════════════════════════════════════
let ebayTokenCache = null;

async function getEbayToken() {
  if (ebayTokenCache && ebayTokenCache.expires > Date.now()) {
    return ebayTokenCache.token;
  }

  const creds = Buffer.from(`${EBAY_APP_ID}:${EBAY_CERT_ID}`).toString("base64");

  const resp = await axios.post(
    "https://api.ebay.com/identity/v1/oauth2/token",
    "grant_type=client_credentials",
    {
      headers: {
        Authorization: `Basic ${creds}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
    }
  );

  ebayTokenCache = {
    token: resp.data.access_token,
    expires: Date.now() + resp.data.expires_in * 1000,
  };

  return ebayTokenCache.token;
}

// ═══════════════════════════════════════════════
// EBAY PRICES
// ═══════════════════════════════════════════════
async function getEbayPrices(query) {
  const token = await getEbayToken();

  const resp = await axios.get(
    "https://api.ebay.com/buy/browse/v1/item_summary/search",
    {
      params: { q: query, limit: 20 },
      headers: {
        Authorization: `Bearer ${token}`,
        "X-EBAY-C-MARKETPLACE-ID": "EBAY_FR",
      },
    }
  );

  const items = resp.data.itemSummaries || [];
  const prices = items
    .map((i) => parseFloat(i.price?.value))
    .filter(Boolean)
    .sort((a, b) => a - b);

  if (!prices.length) return null;

  return {
    min: prices[0],
    max: prices[prices.length - 1],
    count: prices.length,
  };
}

// ═══════════════════════════════════════════════
// API MAIN
// ═══════════════════════════════════════════════
app.post("/analyze", async (req, res) => {
  try {
    const { image } = req.body;

    const product = await recognizeProduct(image);

    const query = product.productName;

    const ebay = await getEbayPrices(query);

    res.json({
      product,
      ebay,
    });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.listen(PORT, () => {
  console.log("Cashizi backend running on port", PORT);
});