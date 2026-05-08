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
        const images = req.body.images || [];
        // URL testée et validée pour Gemini 1.5 Flash
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${KEY}`;
        
        const parts = images.map(b => ({
            inline_data: { mime_type: "image/jpeg", data: b }
        }));
        
        parts.push({ text: "Identifie l'objet et donne une estimation de prix d'occasion en France. Réponds uniquement en JSON: {\"productName\":\"...\",\"priceMin\":0,\"priceMax\":0,\"suggestedPrice\":0,\"description\":\"...\"}" });

        const r = await axios.post(url, {
            contents: [{ parts }]
        }, {
            headers: { 'Content-Type': 'application/json' }
        });

        if (r.data.candidates && r.data.candidates[0]) {
            let txt = r.data.candidates[0].content.parts[0].text;
            let clean = txt.replace(/```json|```/g, "").trim();
            res.json(JSON.parse(clean));
        } else {
            res.status(500).json({ error: "Pas de réponse de l'IA", raw: r.data });
        }

    } catch (e) {
        // ICI : On récupère l'erreur réelle de Google
        const errorMsg = e.response ? JSON.stringify(e.response.data) : e.message;
        console.error("DEBUG GOOGLE:", errorMsg);
        res.status(500).json({ error: "Erreur IA Detaillee", details: errorMsg });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));