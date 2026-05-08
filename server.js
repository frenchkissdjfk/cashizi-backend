const express = require("express");
const axios = require("axios");
const cors = require("cors");
const app = express();
const PORT = process.env.PORT || 10000;

app.use(cors());
app.use(express.json({ limit: "15mb" }));

const KEY = process.env.GEMINI_KEY || "AIzaSyBmm0uDpnppZdwWR-_Ff42rN1_It7eanqQ";

app.get("/", (req, res) => res.send("Cashizi Ready"));

app.post("/analyze", async (req, res) => {
    try {
        console.log("Requête reçue !");
        const images = req.body.images || [];
        
        // URL STABLE (v1 au lieu de v1beta)
        const url = `https://generativelanguage.googleapis.com/v1/models/gemini-1.5-flash:generateContent?key=${KEY}`;
        
        const parts = images.slice(0, 3).map(b => ({ inline_data: { mime_type: "image/jpeg", data: b } }));
        parts.push({ text: "Analyse ces photos. Donne nom du produit, marque, et une estimation de prix d'occasion en France. Réponds UNIQUEMENT en JSON brut : {\"productName\":\"...\",\"priceMin\":0,\"priceMax\":0,\"suggestedPrice\":0,\"description\":\"...\"}" });
        
        const r = await axios.post(url, { contents: [{ parts }] });
        
        if (!r.data.candidates || !r.data.candidates[0]) {
            throw new Error("Gemini n'a pas renvoyé de résultat");
        }

        const txt = r.data.candidates[0].content.parts[0].text;
        const clean = txt.replace(/```json|```/g, "").trim();
        
        console.log("Analyse réussie");
        res.json(JSON.parse(clean));

    } catch (e) {
        console.error("ERREUR:", e.response ? e.response.data : e.message);
        res.status(500).json({ error: "Erreur IA", details: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));