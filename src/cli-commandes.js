// Récupération des commandes Shopify : npm run commandes -- [--depuis YYYY-MM-DD] [--limite N] [--filtre "..."]

import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { recupererCommandes } from './commandes.js';

const AIDE = `
Usage : npm run commandes -- [options]

  --depuis YYYY-MM-DD   commandes créées à partir de cette date
  --limite N            nombre maximum de commandes (défaut : 50)
  --filtre "..."        filtre de recherche Shopify, ex. "financial_status:paid"
  --tout                récupère toutes les commandes (ignore --limite)
  --help                affiche cette aide

Les commandes sont affichées et enregistrées dans sortie/commandes-<horodatage>.json
`;

const { values: args } = parseArgs({
  options: {
    depuis: { type: 'string' },
    limite: { type: 'string', default: '50' },
    filtre: { type: 'string' },
    tout: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});

if (args.help) {
  console.log(AIDE);
  process.exit(0);
}

if (args.depuis && !/^\d{4}-\d{2}-\d{2}$/.test(args.depuis)) {
  console.error('--depuis doit être au format YYYY-MM-DD');
  process.exit(1);
}
const limite = args.tout ? Infinity : Number.parseInt(args.limite, 10);
if (!(limite > 0)) {
  console.error('--limite doit être un entier positif');
  process.exit(1);
}

try {
  const client = creerClient(configShopify());

  const { commandes, avertissements } = await recupererCommandes(client, {
    depuis: args.depuis,
    limite,
    filtre: args.filtre,
  });

  for (const a of avertissements) console.warn(`⚠ ${a}`);

  if (commandes.length === 0) {
    console.log('Aucune commande trouvée.');
    process.exit(0);
  }

  console.table(
    commandes.map((c) => ({
      numero: c.numero,
      date: c.creeLe.slice(0, 10),
      client: c.entreprise?.nom ?? c.client?.nom ?? '—',
      codeSage: c.entreprise?.codeSage ?? '',
      paiement: c.statutPaiement,
      expedition: c.statutExpedition,
      lignes: c.lignes.length,
      total: `${c.total.toFixed(2)} ${c.devise}`,
    })),
  );

  await mkdir('sortie', { recursive: true });
  const fichier = `sortie/commandes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(fichier, JSON.stringify(commandes, null, 2), 'utf8');
  console.log(`${commandes.length} commande(s) enregistrée(s) dans ${fichier}`);
} catch (err) {
  console.error(`Erreur : ${err.message}`);
  process.exit(1);
}
