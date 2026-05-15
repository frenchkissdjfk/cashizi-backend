import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "20mb" })); // Large pour 3 photos

const GEMINI_KEY = process.env.GEMINI_KEY;

async function analyzeWithGemini(images) {
  // URL propre pour ton accès payant
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  
  const imageParts = images.map(b64 => ({
    inline_data: { mime_type: "image/jpeg", data: b64 }
  }));

  const payload = {
    contents: [{
      parts: [
        ...imageParts,
        { text: `
Identifie cet objet comme Google Lens.
Aide-moi à le vendre sur Leboncoin ou Vinted.

Réponds UNIQUEMENT en JSON avec cette structure :
{
  "name": "Marque et modèle précis",
  "priceMin": 10,
  "priceMax": 30,
  "sellingTime": "Estimation temps de vente",
  "conclusion": "Est-ce que ça vaut le coup ? Pourquoi ?",
  "adTitle": "Titre d'annonce optimisé",
  "adDescription": "Description complète avec points forts",
  "tips": "Conseils photo et négociation"
}
` }
      ]
    }],
    generationConfig: { temperature: 0.2, response_mime_type: "application/json" }
  };

  const res = await axios.post(url, payload, { timeout: 30000 });
  
  // Parse le JSON de Gemini
  const content = res.data.candidates[0].content.parts[0].text;
  return JSON.parse(content);
}

app.post("/analyze", async (req, res) => {
  console.log("--- ANALYSE EN COURS ---");
  try {
    const { images } = req.body;
    if (!images || images.length === 0) {
      return res.status(400).json({ error: "Aucune photo reçue" });
    }

    const result = await analyzeWithGemini(images);
    console.log("✅ Objet identifié :", result.name);

    res.json({
      status: "success",
      ...result
    });

  } catch (err) {
    console.error("🔥 ERREUR :", err.message);
    res.status(500).json({ 
      status: "error", 
      message: "Gemini est timide, réessaye !",
      details: err.message 
    });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => console.log(`🚀 CASHIZI SURPUISSANT SUR PORT ${PORT}`));