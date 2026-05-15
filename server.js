import express from "express";
import axios from "axios";
import cors from "cors";

const app = express();
const PORT = process.env.PORT || 10000;

// Augmentation de la limite pour accepter 3 photos haute résolution
app.use(cors({ origin: "*" }));
app.use(express.json({ limit: "50mb" })); 

const GEMINI_KEY = process.env.GEMINI_KEY;

async function analyzeWithGemini(images) {
  // Utilisation de la version stable v1
  const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${GEMINI_KEY}`;
  
  // Préparation des 3 images obligatoires
  const imageParts = images.slice(0, 3).map(b64 => {
    // Nettoyage au cas où le Base64 contient le préfixe data:image
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
        { text: `Tu es un expert en revente d'objets d'occasion (type Google Lens + expert en pricing).
          Analyse ces 3 photos (vue d'ensemble, détails/étiquettes, état).
          
          Donne-moi :
          1. Nom exact, marque et modèle.
          2. Estimation prix d'occasion (Min et Max en Euros).
          3. Temps de vente estimé (ex: "1-2 semaines").
          4. Conclusion franche : Est-ce que ça vaut le coup de le vendre ? Pourquoi ?
          5. Une annonce complète : Titre accrocheur et description détaillée.
          6. Conseils stratégiques : Meilleure plateforme (Vinted, LBC, eBay), conseils photos et négociation.

          Réponds EXCLUSIVEMENT au format JSON suivant, sans texte autour :
          {
            "name": "",
            "priceMin": 0,
            "priceMax": 0,
            "sellingTime": "",
            "conclusion": "",
            "adTitle": "",
            "adDescription": "",
            "tips": ""
          }` 
        }
      ]
    }],
    generationConfig: {
      temperature: 0.4, // Un peu plus de créativité pour l'annonce
      topP: 0.9,
      maxOutputTokens: 1000
    }
  };

  try {
    const res = await axios.post(url, payload, { 
      headers: { "Content-Type": "application/json" },
      timeout: 45000 // On laisse 45s car 3 photos + analyse longue = temps de calcul
    });

    if (!res.data || !res.data.candidates) {
      throw new Error("Réponse vide de Google");
    }

    const rawText = res.data.candidates[0].content.parts[0].text;
    
    // Nettoyage sécurisé du JSON (au cas où Gemini met des balises ```json)
    const cleanJson = rawText.replace(/
```json|```/g, "").trim();
    return JSON.parse(cleanJson);

  } catch (error) {
    console.error("Détails Erreur Google:", error.response?.data || error.message);
    throw error;
  }
}

app.post("/analyze", async (req, res) => {
  console.log("--- DÉBUT ANALYSE (3 PHOTOS) ---");
  
  try {
    const { images } = req.body;

    if (!images || images.length < 3) {
      console.log("⚠️ Erreur: Moins de 3 images reçues");
      return res.status(400).json({ error: "L'application doit envoyer 3 photos obligatoires." });
    }

    const result = await analyzeWithGemini(images);
    console.log("✅ Analyse réussie pour :", result.name);

    res.json({
      status: "success",
      ...result
    });

  } catch (err) {
    console.error("🔥 CRASH :", err.message);
    res.status(500).json({ 
      status: "error", 
      message: "L'analyse a échoué. Vérifie la taille de tes photos ou ta connexion.",
      details: err.message 
    });
  }
});

app.get("/health", (req, res) => res.json({ status: "running" }));

app.listen(PORT, () => console.log(`🚀 SERVEUR CASHIZI ACTIF SUR PORT ${PORT}`));