// ═══════════════════════════════════════════════════════════════════════
//  CASHIZI — Backend production
//  Principe : UNE seule requête Gemini Vision fait tout
//  (comme l'appli Gemini sur smartphone)
//  Render free tier compatible
// ═══════════════════════════════════════════════════════════════════════

import express   from "express";
import axios     from "axios";
import cors      from "cors";

const app  = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*", methods: ["GET", "POST"] }));
app.use(express.json({ limit: "25mb" }));

const GEMINI_KEY = process.env.GEMINI_KEY;

if (!GEMINI_KEY) {
  console.error("❌  GEMINI_KEY manquante — ajoutez-la dans les variables Render");
  process.exit(1);
}

// ── Modèles avec fallback ─────────────────────────────────────────────
const MODELS = [
  "gemini-3-flash",
  "gemini-3-flash-lite",
  "gemini-1.5-flash",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ════════════════════════════════════════════════════════════════════════
//  Extraction JSON robuste depuis la réponse Gemini
// ════════════════════════════════════════════════════════════════════════
function extractJSON(text) {
  if (!text) return null;

  // 1. Direct
  try { return JSON.parse(text.trim()); } catch {}

  // 2. Retire les blocs ```json ... ```
  const stripped = text.replace(/```json\s*/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(stripped); } catch {}

  // 3. Extrait le premier bloc { ... }
  const match = stripped.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try { return JSON.parse(match[0]); } catch {}

  // 4. Répare un JSON tronqué
  let repaired = match[0];
  if ((repaired.match(/(?<!\\)"/g) || []).length % 2 === 1) repaired += '"';
  const opens  = (repaired.match(/\{/g) || []).length;
  const closes = (repaired.match(/\}/g) || []).length;
  for (let i = 0; i < opens - closes; i++) repaired += "}";
  try { return JSON.parse(repaired); } catch {}

  return null;
}

// ════════════════════════════════════════════════════════════════════════
//  Appel Gemini Vision — v1beta — avec fallback modèles
// ════════════════════════════════════════════════════════════════════════
async function callGemini(payload) {
  for (const model of MODELS) {
    const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`;
    try {
      const res  = await axios.post(url, payload, {
        headers: { "Content-Type": "application/json" },
        timeout: 40000,
      });
      const text = res.data?.candidates?.[0]?.content?.parts?.[0]?.text ?? "";
      if (text.length > 10) {
        console.log(`✅ Gemini OK — ${model}`);
        return text;
      }
      console.warn(`⚠️  ${model} → réponse vide`);
    } catch (err) {
      const status = err.response?.status;
      const msg    = err.response?.data?.error?.message || err.message;
      console.warn(`⚠️  ${model} → HTTP ${status || "?"} — ${msg}`);
      if (status === 429) await sleep(2000);
    }
  }
  return null;
}

// ════════════════════════════════════════════════════════════════════════
//  POST /analyze
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

    // ── Construit les parties image (max 3)
    const imageParts = images.slice(0, 3).map((b64) => ({
      inline_data: { mime_type: "image/jpeg", data: b64 },
    }));

    // ── LE prompt : exactement ce que tu fais sur l'appli Gemini,
    //    + génération de l'annonce complète + format JSON pour Flutter
    const prompt = `Tu es un expert en vente d'objets d'occasion en France, aussi précis que Google Lens.

À partir de ces ${images.length} photo(s) de l'objet (face, étiquette, 3/4, usures), fais l'analyse complète :

1. Identifie l'objet avec précision (marque, modèle, référence si lisible sur étiquette)
2. Estime une fourchette de prix de revente réaliste en France (Vinted, Leboncoin, eBay)
3. Estime le temps de vente probable
4. Conclus si ça vaut le coup ou non de vendre cet objet
5. Si ça vaut le coup, génère une annonce de vente parfaite prête à publier

Réponds UNIQUEMENT en JSON valide, sans markdown, sans backticks, sans texte autour :
{
  "credible": true,
  "productName": "nom précis de l'objet (marque + modèle si visible)",
  "brand": "marque ou null",
  "condition": "excellent|bon|passable|mauvais",
  "suggestions": ["nom variante 1", "nom variante 2", "nom variante 3"],
  "priceRange": "X € – Y €",
  "suggestedPrice": "Z €",
  "timeRange": "~N jours",
  "platform": "plateforme recommandée (Vinted / Leboncoin / eBay / etc.)",
  "title": "titre d'annonce optimisé prêt à copier-coller (max 70 car.)",
  "description": "description complète et naturelle prête à coller (3-5 phrases, ton vendeur français, mentionne l'état, les caractéristiques, ce qui est inclus)",
  "negotiationTip": "conseil de négociation personnalisé pour cet objet (1-2 phrases)",
  "photoTip": "conseil photo pratique pour maximiser les chances de vente (1-2 phrases)",
  "reason": "si credible=false : explication courte et honnête pourquoi ça ne vaut pas le coup. Si credible=true : null"
}

Règles pour credible :
- false si prix médian estimé < 15 € OU si le temps de vente dépasse 50 jours
- true sinon`;

    const payload = {
      contents: [{
        parts: [...imageParts, { text: prompt }],
      }],
      generationConfig: {
        temperature: 0.2,      // peu de créativité = réponses cohérentes
        maxOutputTokens: 1000,
      },
    };

    const rawText = await callGemini(payload);
    console.log("📦 RAW:", rawText?.substring(0, 400));

    if (!rawText) {
      return res.status(503).json({
        error: "Gemini indisponible, réessayez dans quelques secondes.",
      });
    }

    const result = extractJSON(rawText);

    if (!result) {
      console.error("❌ JSON invalide :", rawText?.substring(0, 300));
      return res.status(500).json({
        error: "Réponse Gemini mal formée, réessayez.",
      });
    }

    // ── Normalise les champs pour correspondre au modèle Flutter AiResult
    const response = {
      credible:       result.credible       ?? false,
      productName:    result.productName    ?? "Objet inconnu",
      brand:          result.brand          ?? null,
      condition:      result.condition      ?? null,
      suggestions:    result.suggestions    ?? [],
      priceRange:     result.priceRange     ?? "–",
      suggestedPrice: result.suggestedPrice ?? "–",
      timeRange:      result.timeRange      ?? "–",
      platform:       result.platform       ?? "Leboncoin",
      title:          result.title          ?? "",
      description:    result.description    ?? "",
      negotiationTip: result.negotiationTip ?? "",
      photoTip:       result.photoTip       ?? "",
      reason:         result.reason         ?? null,
    };

    console.log(`🧠 ${response.credible ? "CRÉDIBLE ✅" : "PAS CRÉDIBLE ❌"} — "${response.productName}" — ${Date.now() - t0}ms`);

    return res.json(response);

  } catch (err) {
    console.error("❌ /analyze:", err.message);
    return res.status(500).json({ error: err.message });
  }
});

// ── Health check ──────────────────────────────────────────────────────
app.get("/health", (_, res) =>
  res.json({ status: "ok", ts: Date.now() }));

// ── Keep-alive Render gratuit (dort après 15min d'inactivité) ─────────
setInterval(async () => {
  try {
    await axios.get("https://cashizi-backend.onrender.com/health",
        { timeout: 5000 });
    console.log(`[${new Date().toISOString()}] 🏓 keep-alive`);
  } catch (_) {}
}, 14 * 60 * 1000);

app.listen(PORT, () =>
  console.log(`🚀 Cashizi backend — port ${PORT}`));