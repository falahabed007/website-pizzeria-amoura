const express = require('express');
const path = require('path');
const fs = require('fs');
const app = express();

// Statische Dateien (CSS, Bilder, etc.) direkt ausliefern
app.use(express.static(path.join(__dirname), { index: false }));

// index.html mit Umgebungsvariablen befüllen
app.get('/', (req, res) => {
  let html = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
  html = html
    .replace('IHR_PUBLIC_KEY',  process.env.EMAILJS_PUBLIC_KEY  || 'IHR_PUBLIC_KEY')
    .replace('IHR_SERVICE_ID',  process.env.EMAILJS_SERVICE_ID  || 'IHR_SERVICE_ID')
    .replace('IHR_TEMPLATE_ID', process.env.EMAILJS_TEMPLATE_ID || 'IHR_TEMPLATE_ID');
  res.send(html);
});

// Alle anderen Routen → index.html
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`FlueVate läuft auf Port ${PORT}`));
