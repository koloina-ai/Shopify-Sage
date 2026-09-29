// Catalogue Sage -> Shopify par famille (1 famille = 1 produit, 1 article = 1 variante) :
// npm run catalogue -- [--famille CODE ...] [--simulation] [--forcer-prix]
// Crée les familles et variantes manquantes, met à jour prix, code-barre et désignation des variantes.
// Les stocks sont mis à jour par l'étape stocks (npm run stocks).

import { parseArgs } from 'node:util';
import { mkdir, writeFile } from 'node:fs/promises';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { connecterSage, depotsStock, famillesCatalogue, lireArticlesFamilles } from './sage.js';
import { appliquerCatalogue, emplacementParDefaut, lireFamillesShopify, planifierCatalogue, versFamilleShopify } from './familles.js';

// Garde-fou prix : variation maximale appliquée automatiquement (0.5 = ±50 %) ; 0 = désactivé
const VARIATION_PRIX_MAX = process.env.PRIX_VARIATION_MAX !== undefined ? Number(process.env.PRIX_VARIATION_MAX) : 0.5;
// Statut des familles créées : ACTIVE (en vente) ou DRAFT (à publier à la main après relecture)
const STATUT_CREATION = (process.env.PRODUITS_STATUT_CREATION || 'ACTIVE').toUpperCase() === 'DRAFT' ? 'DRAFT' : 'ACTIVE';

const { values: args } = parseArgs({
  options: {
    famille: { type: 'string', multiple: true },
    simulation: { type: 'boolean', default: false },
    'forcer-prix': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log(`
Usage : npm run catalogue -- [options]

  (sans option)     familles de CATALOGUE_FAMILLES (codes famille Sage, ou *)
  --famille CODE    une ou plusieurs familles précises (option répétable)
  --simulation      affiche ce qui serait fait, sans rien envoyer à Shopify
  --forcer-prix     applique aussi les variations de prix de plus de ${VARIATION_PRIX_MAX * 100} %

1 famille Sage = 1 produit Shopify, 1 article = 1 variante (SKU = référence Sage).
Le contenu des produits (titre, description, photos…) n'est jamais écrasé. Rien n'est supprimé.
`);
  process.exit(0);
}

// Fin anticipée sans process.exit() : avec le pilote SQL Windows (msnodesqlv8), process.exit() pendant qu'une
// connexion est ouverte fait planter Node à la fermeture et fausse le code retour (fausses alertes).
const terminer = (code = 0) => {
  throw Object.assign(new Error('fin'), { finAnticipee: code });
};

let pool;
try {
  const familles = args.famille?.length ? args.famille : famillesCatalogue();
  pool = await connecterSage();
  const articles = await lireArticlesFamilles(pool, familles);

  const client = creerClient(configShopify());
  const locationId = await emplacementParDefaut(client);
  const shopify = await lireFamillesShopify(client, locationId);
  const plan = planifierCatalogue(articles, shopify, { variationPrixMax: VARIATION_PRIX_MAX, forcerPrix: args['forcer-prix'] });

  const nbAjouts = plan.ajouts.reduce((n, a) => n + a.variantes.length, 0);
  const nbCreees = plan.creations.reduce((n, c) => n + c.variantes.length, 0);
  const nbMaj = plan.majs.reduce((n, m) => n + m.variantes.length, 0);
  console.log(
    `Familles : ${familles.includes('*') ? 'toutes' : familles.join(', ')} — ${articles.length} article(s) Sage, dépôt(s) ${depotsStock().join(' + ')}`,
  );
  console.log(
    `À faire : ${plan.creations.length} famille(s) à créer (${nbCreees} variantes), ${nbAjouts} variante(s) à ajouter, ` +
      `${nbMaj} variante(s) à mettre à jour, ${plan.prixBloques.length} prix bloqué(s), ${plan.signalements.length} signalement(s)`,
  );

  if (args.simulation) {
    if (plan.creations.length) {
      console.log('Simulation — exemple de famille créée :');
      const exemple = versFamilleShopify(plan.creations[0].code, plan.creations[0].variantes.slice(0, 2), { locationId: '(emplacement)', statut: STATUT_CREATION });
      console.log(JSON.stringify(exemple, null, 2));
      console.table(plan.creations.map((c) => ({ famille: c.code, variantes: c.variantes.length })));
    }
    for (const m of plan.majs) {
      console.table(m.variantes.map((v) => ({ famille: m.famille.code, ref: v.article.AR_Ref, ...v.changements })));
    }
    if (plan.signalements.length) console.table(plan.signalements);
    terminer(0);
  }

  const bilan = await appliquerCatalogue(client, plan, { locationId, statutCreation: STATUT_CREATION });
  bilan.prixBloques = plan.prixBloques;
  bilan.signalements = plan.signalements;

  console.log(
    `Familles créées : ${bilan.famillesCreees.length}   Variantes ajoutées : ${bilan.variantesAjoutees.length}   ` +
      `Mises à jour : ${bilan.variantesMisesAJour.length}   Erreurs : ${bilan.erreurs.length}`,
  );
  for (const p of bilan.prixBloques) {
    console.warn(`⚠ Prix non appliqué ${p.ref} (${p.famille}) : ${p.ancien} → ${p.nouveau} (${p.variation > 0 ? '+' : ''}${p.variation} %), à vérifier dans Sage (--forcer-prix pour l'appliquer)`);
  }
  // Les signalements sont des informations (pas des erreurs) : résumé par raison dans le journal, détail dans le rapport
  const parRaison = plan.signalements.reduce((m, s) => m.set(s.raison, (m.get(s.raison) ?? 0) + 1), new Map());
  for (const [raison, n] of parRaison) console.log(`  ℹ ${n} × ${raison}`);
  for (const e of bilan.erreurs) console.error(`  ✗ famille ${e.famille} : ${e.message}`);

  await mkdir('sortie', { recursive: true });
  const rapport = `sortie/synchro-catalogue-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(rapport, JSON.stringify(bilan, null, 2), 'utf8');
  console.log(`Rapport : ${rapport}`);

  if (bilan.erreurs.length === 0) {
    await mkdir('etat', { recursive: true });
    await writeFile('etat/catalogue.json', JSON.stringify({ dernier: new Date().toISOString(), familles }, null, 2));
  }
  process.exitCode = bilan.erreurs.length ? 1 : 0;
} catch (err) {
  if ('finAnticipee' in err) process.exitCode = err.finAnticipee;
  else {
    console.error(`Erreur : ${err.message}`);
    process.exitCode = 1;
  }
} finally {
  await pool?.close();
}
