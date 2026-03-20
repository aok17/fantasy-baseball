import 'dotenv/config';
import express from 'express';
import cors from 'cors';
import { join, dirname } from 'path';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { createDb } from './db.js';
import { createRankingsRouter } from './routes/rankings.js';
import { createDraftRouter } from './routes/draft.js';
import { createConfigRouter } from './routes/config.js';
import { createScrapeRouter } from './routes/scrape.js';

const db = createDb();
const app = express();

app.use(cors());
app.use(express.json());

app.use('/api/rankings', createRankingsRouter(db));
app.use('/api/draft', createDraftRouter(db));
app.use('/api/config', createConfigRouter(db));
app.use('/api/scrape', createScrapeRouter(db));

// Serve built client in production
const clientDist = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'client', 'dist');
if (existsSync(clientDist)) {
  app.use(express.static(clientDist));
  app.get('*', (req, res) => {
    res.sendFile(join(clientDist, 'index.html'));
  });
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Server running on http://localhost:${PORT}`);
});
