// Synchro Sage -> Shopify des produits.
// npm run produits -- [--poc] [--tout] [--ref AR_Ref ...] [--simulation]

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { connecterSage, lireArticles, ean13Valide } from './sage.js';
import { emplacementParDefaut, synchroniserProduits, versProduitShopify } from './produits.js';
import { lireStocksShopify } from './stocks.js';

const FICHIER_ETAT = 'etat/synchro-produits.json';

const AIDE = `
Usage : npm run produits -- [options]

  (sans option)   synchro incrémentale : articles modifiés dans Sage depuis la dernière synchro,
                  et articles absents de Shopify (nouveaux, supprimés par erreur…).
                  Garde le périmètre de la synchro précédente (poc ou tout).
  --poc           limite aux produits « prêts POC » : prix, stock et code-barre EAN valide
  --tout          tous les articles publiables, tous renvoyés (ignore la dernière synchro)
  --ref AR_Ref    un ou plusieurs articles précis (option répétable)
  --simulation    n'envoie rien à Shopify : affiche ce qui serait envoyé
`;

const { values: args } = parseArgs({
  options: {
    poc: { type: 'boolean', default: false },
    tout: { type: 'boolean', default: false },
    ref: { type: 'string', multiple: true },
    simulation: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log(AIDE);
  process.exit(0);
}

const lireEtat = async () => JSON.parse(await readFile(FICHIER_ETAT, 'utf8').catch(() => '{}'));

// Le driver lit les DATETIME Sage (heure locale, sans fuseau) comme de l'UTC : on réaffiche la valeur brute.
const dateSage = (d) => d.toISOString().replace('T', ' ').slice(0, 19);

let pool;
try {
  const etat = await lireEtat();
  // Périmètre : celui demandé, sinon celui de la synchro précédente (pour ne pas passer du POC à tout le catalogue par surprise).
  const perimetre = args.tout ? 'tout' : args.poc ? 'poc' : etat.perimetre;
  // --tout et --ref renvoient tout leur périmètre ; sinon : modifiés depuis la dernière synchro + absents de Shopify.
  const incremental = !args.tout && !args.ref && Boolean(etat.derniereModification);
  if (!incremental && !args.poc && !args.tout && !args.ref) {
    throw new Error('Aucune synchro précédente : lancer d\'abord avec --poc, --tout ou --ref');
  }
  if (!perimetre && !args.ref) {
    throw new Error('Périmètre inconnu : préciser --poc (produits prêts POC) ou --tout (tout le catalogue publiable)');
  }

  pool = await connecterSage();
  let articles = await lireArticles(pool, { refs: args.ref, avecStock: perimetre === 'poc' && !args.ref });
  if (perimetre === 'poc' && !args.ref) {
    articles = articles.filter((a) => ean13Valide(a.AR_CodeBarre) && a.AR_Design.trim().length >= 4);
  }

  const client = creerClient(configShopify());
  const locationId = await emplacementParDefaut(client);

  if (incremental) {
    const depuis = new Date(etat.derniereModification);
    const presents = new Set((await lireStocksShopify(client, locationId)).map((p) => p.sku));
    const modifies = articles.filter((a) => a.cbModification > depuis && presents.has(a.AR_Ref));
    const absents = articles.filter((a) => !presents.has(a.AR_Ref));
    articles = [...absents, ...modifies];
    console.log(
      `Périmètre « ${perimetre} » : ${modifies.length} article(s) modifié(s) dans Sage depuis ${dateSage(depuis)}, ` +
        `${absents.length} absent(s) de Shopify`,
    );
  } else {
    console.log(`${articles.length} article(s) à synchroniser`);
  }
  if (articles.length === 0) process.exit(0);

  if (args.simulation) {
    console.log('Simulation — exemple de produit envoyé :');
    console.log(JSON.stringify(versProduitShopify(articles[0], { locationId: '(emplacement)', creation: true }), null, 2));
    console.table(articles.map((a) => ({ ref: a.AR_Ref, titre: a.AR_Design, prix: a.AR_PrixVen, stock: a.stock_dispo })));
    process.exit(0);
  }

  const bilan = await synchroniserProduits(client, articles, {
    locationId,
    surProgression: (n, total) => process.stdout.write(`\r  envoi ${n}/${total}`),
  });
  process.stdout.write('\n');

  console.log(`Créés : ${bilan.crees.length}   Mis à jour : ${bilan.misAJour.length}   Erreurs : ${bilan.erreurs.length}`);
  for (const e of bilan.erreurs) console.error(`  ✗ ${e.ref} : ${e.message}`);

  await mkdir('sortie', { recursive: true });
  const rapport = `sortie/synchro-produits-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(rapport, JSON.stringify(bilan, null, 2), 'utf8');
  console.log(`Rapport : ${rapport}`);

  // On ne mémorise la progression que si tout est passé, pour retenter les échecs au prochain lancement.
  if (bilan.erreurs.length === 0) {
    const max = articles.reduce((m, a) => (a.cbModification > m ? a.cbModification : m), new Date(etat.derniereModification ?? 0));
    await mkdir('etat', { recursive: true });
    await writeFile(
      FICHIER_ETAT,
      JSON.stringify({ derniereModification: max.toISOString(), perimetre, le: new Date().toISOString() }, null, 2),
    );
  }
  process.exitCode = bilan.erreurs.length ? 1 : 0;
} catch (err) {
  console.error(`Erreur : ${err.message}`);
  process.exitCode = 1;
} finally {
  await pool?.close();
}
