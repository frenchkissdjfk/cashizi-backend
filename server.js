import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" })); 

const GEMINI_KEY = process.env.GEMINI_KEY;

async function analyzeWithGemini(images) {
  // On passe en v1beta qui est plus permissive sur les noms de modèles
  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  
  const imageParts = images.slice(0, 3).map(b64 => {
    const cleanB64 = b64.includes(",") ? b64.split(",")[1] : b64;
    return {
      inline_data: { 
        mime_type: "image/jpeg", 
        data: cleanB64 
      }
    };
  });

  const payload = {
    contents: [{
      parts: [
        ...imageParts,
        { text: "Identifie cet objet (nom, marque, modèle). Donne une estimation de prix occasion (Min/Max Euros), temps de vente, et une conclusion. Crée aussi une annonce (titre et description). Réponds UNIQUEMENT en JSON avec cette structure: {\"name\":\"\",\"priceMin\":0,\"priceMax\":0,\"sellingTime\":\"\",\"conclusion\":\"\",\"adTitle\":\"\",\"adDescription\":\"\",\"tips\":\"\"}" }
      ]
    }],
    generationConfig: {
      temperature: 0.4,
      maxOutputTokens: 1200
    }
  };

  try {
    const res = await axios.post(url, payload, { 
      headers: { "Content-Type": "application/json" },
      timeout: 50000 
    });

    if (!res.data || !res.data.candidates) {
      throw new Error("Réponse vide de l'API");
    }

    let rawText = res.data.candidates[0].content.parts[0].text;
    
    let cleanJson = rawText.trim();
    const firstBracket = cleanJson.indexOf('{');
    const lastBracket = cleanJson.lastIndexOf('}');
    
    if (firstBracket !== -1 && lastBracket !== -1) {
        cleanJson = cleanJson.substring(firstBracket, lastBracket + 1);
    }
    
    return JSON.parse(cleanJson);

  } catch (error) {
    // Log plus précis pour voir l'origine de la 404
    if (error.response) {
      console.error("ERREUR GOOGLE:", error.response.status, error.response.data);
    }
    throw error;
  }
}

app.post("/analyze", async (req, res) => {
  console.log("--- REQUÊTE REÇUE ---");
  try {
    const { images } = req.body;
    if (!images || images.length < 3) {
      console.log("❌ Manque des images");
      return res.status(400).json({ error: "3 photos requises" });
    }

    const result = await analyzeWithGemini(images);
    console.log("✅ ANALYSE OK :", result.name);
    res.json({ status: "success", ...result });

  } catch (err) {
    console.error("🔥 CRASH :", err.message);
    res.status(500).json({ status: "error", details: err.message });
  }
});

app.get("/health", (req, res) => res.json({ status: "ok" }));

app.listen(PORT, () => {
  console.log(`🚀 SERVEUR PRÊT SUR PORT ${PORT}`);
});