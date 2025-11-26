import express from 'express';
import cors from 'cors';
import { readdirSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';

const app = express();
app.use(cors());
app.use(express.json());

// Fix voor __dirname in ES modules
const __dirname = fileURLToPath(new URL('.', import.meta.url));

const PORT = process.env.PORT || 3006;

async function main() {
  // Dynamisch alle routers inladen uit endpoints/
  const endpointsDir = join(__dirname, 'endpoints');
  const files = readdirSync(endpointsDir);

  for (const file of files) {
    if (file.endsWith('.js')) {
      const routeName = file.replace('.js', '');
      const routerModule = await import(`./endpoints/${file}`);
      app.use(`/api/${routeName}`, routerModule.default);
      console.log(` /api/${routeName} gekoppeld`);
    }
  }

  app.listen(PORT, () => {
    console.log(` Server draait op interne poort ${PORT} en extern http://devserv01.holdingthedrones.com:4566`);
  });
}

main().catch((err) => {
  console.error(' Fout bij starten server:', err);
});
