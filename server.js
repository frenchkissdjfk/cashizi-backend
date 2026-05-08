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
        const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${KEY}`;
        const parts = images.slice(0, 3).map(b => ({ inline_data: { mime_type: "image/jpeg", data: b } }));
        parts.push({ text: "Analyse ces photos. Donne nom du produit, marque, et une estimation de prix min/max en France. Réponds UNIQUEMENT en JSON brut : {\"productName\":\"...\",\"priceMin\":0,\"priceMax\":0,\"suggestedPrice\":0,\"description\":\"...\"}" });
        
        const r = await axios.post(url, { contents: [{ parts }] });
        const txt = r.data.candidates[0].content.parts[0].text;
        const clean = txt.replace(/```json|```/g, "").trim();
        
        res.json(JSON.parse(clean));
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(PORT, '0.0.0.0', () => console.log(`🚀 Port ${PORT}`));