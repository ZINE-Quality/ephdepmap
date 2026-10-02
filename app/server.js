const express = require('express');
const path = require('path');

// No database, no /api routes - this fork keeps all graph data client-side
// in the browser's localStorage (see public/app.js). The server's only job
// is serving the static files.
const app = express();
app.use(express.static(path.join(__dirname, 'public')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`ephdepmap on :${PORT}`));
