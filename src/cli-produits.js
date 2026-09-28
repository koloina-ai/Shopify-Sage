// Synchro Sage -> Shopify des produits.
// npm run produits -- [--poc] [--tout] [--ref AR_Ref ...] [--simulation] [--forcer-retrait] [--forcer-prix]

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { connecterSage, lireArticles, ean13Valide, raisonsRetrait } from './sage.js';
import { emplacementParDefaut, retirerProduits, synchroniserProduits, versProduitShopify } from './produits.js';
import { lireStocksShopify, produitsGeres } from './stocks.js';
import { ETIQUETTE_RETIRE, handleArticle } from './regles.js';

const FICHIER_ETAT = 'etat/synchro-produits.json';

// Garde-fou : au-delà, on suppose une anomalie (base vide, mauvaise base…) et on ne retire rien.
const RETRAIT_MAX_PART = 0.2;
const RETRAIT_MAX_TOUJOURS_OK = 5;
// Garde-fou prix : variation maximale appliquée automatiquement (0.5 = ±50 %) ; 0 = désactivé
const VARIATION_PRIX_MAX = process.env.PRIX_VARIATION_MAX !== undefined ? Number(process.env.PRIX_VARIATION_MAX) : 0.5;
// Statut des produits créés : ACTIVE (en vente) ou DRAFT (à publier à la main après relecture)
const STATUT_CREATION = (process.env.PRODUITS_STATUT_CREATION || 'ACTIVE').toUpperCase() === 'DRAFT' ? 'DRAFT' : 'ACTIVE';

const AIDE = `
Usage : npm run produits -- [options]

  (sans option)     synchro incrémentale : articles modifiés dans Sage depuis la dernière synchro,
                    articles absents de Shopify (nouveaux, supprimés par erreur…),
                    et retrait (brouillon) des produits qui ne sont plus à publier.
                    Garde le périmètre de la synchro précédente (poc ou tout).
  --poc             limite aux produits « prêts POC » : prix, stock et code-barre EAN valide
  --tout            tous les articles publiables, tous renvoyés (ignore la dernière synchro)
  --ref AR_Ref      un ou plusieurs articles précis (option répétable) ; aucun retrait
  --simulation      n'envoie rien à Shopify : affiche ce qui serait fait
  --forcer-retrait  autorise un retrait massif (plus de ${RETRAIT_MAX_PART * 100} % des produits)
  --forcer-prix     applique aussi les variations de prix de plus de ${VARIATION_PRIX_MAX * 100} %

Protection de la boutique : seuls les produits créés par le connecteur sont modifiés, et seulement sur les champs
qu'il gère. Étiquette « sage-ignorer » sur un produit : le connecteur n'y touche plus.
`;

const { values: args } = parseArgs({
  options: {
    poc: { type: 'boolean', default: false },
    tout: { type: 'boolean', default: false },
    ref: { type: 'string', multiple: true },
    simulation: { type: 'boolean', default: false },
    'forcer-retrait': { type: 'boolean', default: false },
    'forcer-prix': { type: 'boolean', default: false },
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

// Barre de progression seulement dans un terminal (pas dans les journaux de la tâche planifiée).
const progression = process.stdout.isTTY ? (n, total) => process.stdout.write(`\r  envoi ${n}/${total}`) : () => {};

// Fin anticipée sans process.exit() : avec le pilote SQL Windows (msnodesqlv8), process.exit() pendant qu'une
// connexion est ouverte fait planter Node à la fermeture et fausse le code retour (fausses alertes).
const terminer = (code = 0) => {
  throw Object.assign(new Error('fin'), { finAnticipee: code });
};

let pool;
try {
  const etat = await lireEtat();
  // Périmètre : celui demandé, sinon celui de la synchro précédente (pour ne pas passer du POC à tout le catalogue par surprise).
  const perimetre = args.tout ? 'tout' : args.poc ? 'poc' : etat.perimetre;
  // --tout et --ref renvoient tout leur périmètre ; sinon : modifiés depuis la dernière synchro + absents + à réactiver.
  const incremental = !args.tout && !args.ref && Boolean(etat.derniereModification);
  if (!incremental && !args.poc && !args.tout && !args.ref) {
    throw new Error('Aucune synchro précédente : lancer d\'abord avec --poc, --tout ou --ref');
  }
  if (!perimetre && !args.ref) {
    throw new Error('Périmètre inconnu : préciser --poc (produits prêts POC) ou --tout (tout le catalogue publiable)');
  }

  pool = await connecterSage();
  let eligibles = await lireArticles(pool, { refs: args.ref, avecStock: perimetre === 'poc' && !args.ref });
  if (perimetre === 'poc' && !args.ref) {
    eligibles = eligibles.filter((a) => ean13Valide(a.AR_CodeBarre) && a.AR_Design.trim().length >= 4);
  }

  const client = creerClient(configShopify());
  const locationId = await emplacementParDefaut(client);
  const shopify = await lireStocksShopify(client, locationId);
  const parSku = new Map(shopify.map((p) => [p.sku, p]));
  const parHandle = new Map(shopify.map((p) => [p.handle, p]));
  const geres = new Map(produitsGeres(shopify).map((p) => [p.sku, p]));

  // --- Tri des articles éligibles : chacun tombe dans un seul cas ---
  const depuis = incremental ? new Date(etat.derniereModification) : null;
  const aCreer = [];
  const aMettreAJour = [];
  const areactiver = new Set();
  const proteges = []; // présents dans Shopify mais à ne pas toucher (sage-ignorer, ou pas créés par le connecteur)
  for (const a of eligibles) {
    const existant = parSku.get(a.AR_Ref) ?? parHandle.get(handleArticle(a.AR_Ref));
    if (!existant) {
      aCreer.push(a);
    } else if (!geres.has(a.AR_Ref)) {
      proteges.push({ ref: a.AR_Ref, raison: existant.ignore ? 'étiquette sage-ignorer' : 'produit non créé par le connecteur' });
    } else if (existant.statut !== 'ACTIVE' && existant.tags.includes(ETIQUETTE_RETIRE)) {
      areactiver.add(a.AR_Ref); // retiré par le connecteur, de nouveau éligible
      aMettreAJour.push(a);
    } else if (!incremental || a.cbModification > depuis) {
      aMettreAJour.push(a); // y compris un produit masqué à la main : mis à jour, mais laissé masqué
    }
  }
  const articles = [...aCreer, ...aMettreAJour];
  console.log(
    `Périmètre « ${perimetre ?? 'références'} » : ${aCreer.length} à créer, ${aMettreAJour.length - areactiver.size} à mettre à jour` +
      `${incremental ? ` (modifiés dans Sage depuis ${dateSage(depuis)})` : ''}, ${areactiver.size} à remettre en vente` +
      `${proteges.length ? `, ${proteges.length} protégé(s) non modifié(s)` : ''}`,
  );

  // --- À retirer : produits gérés, en vente, dont l'article n'est plus éligible ---
  let aRetirer = [];
  let retraitBloque = false; // anomalie à signaler : la synchro se termine en échec pour être remarquée
  if (!args.ref) {
    const refsEligibles = new Set(eligibles.map((a) => a.AR_Ref));
    const candidats = [...geres.values()].filter((p) => p.statut === 'ACTIVE' && !refsEligibles.has(p.sku));
    const actifs = [...geres.values()].filter((p) => p.statut === 'ACTIVE').length;
    const limite = Math.max(RETRAIT_MAX_TOUJOURS_OK, Math.floor(actifs * RETRAIT_MAX_PART));
    if (candidats.length && eligibles.length === 0) {
      retraitBloque = true;
      console.warn(`⚠ Retrait annulé : aucun article éligible lu dans Sage (base vide ou inaccessible ?)`);
    } else if (candidats.length > limite && !args['forcer-retrait']) {
      retraitBloque = true;
      console.warn(
        `⚠ Retrait annulé : ${candidats.length} produits à retirer sur ${actifs} actifs (limite ${limite}). ` +
          `Vérifier Sage, puis relancer avec --forcer-retrait si c'est voulu.`,
      );
    } else if (candidats.length) {
      const raisons = await raisonsRetrait(pool, candidats.map((p) => p.sku));
      aRetirer = candidats.map((p) => ({ ...p, raison: raisons.get(p.sku) }));
    }
  }
  console.log(`${aRetirer.length} produit(s) à retirer de la vente (passage en brouillon)`);
  for (const p of proteges) console.log(`  = ${p.ref} non modifié : ${p.raison}`);

  if (articles.length === 0 && aRetirer.length === 0) terminer(retraitBloque ? 1 : 0);

  if (args.simulation) {
    if (aCreer.length) {
      console.log('Simulation — exemple de produit créé :');
      console.log(JSON.stringify(versProduitShopify(aCreer[0], { locationId: '(emplacement)', statut: STATUT_CREATION }), null, 2));
    }
    if (articles.length) {
      console.table(articles.map((a) => ({
        ref: a.AR_Ref, action: aCreer.includes(a) ? 'créer' : areactiver.has(a.AR_Ref) ? 'remettre en vente' : 'mettre à jour',
        titre: a.AR_Design, prix: a.AR_PrixVen,
      })));
    }
    if (aRetirer.length) console.table(aRetirer.map((p) => ({ ref: p.sku, raison: p.raison })));
    terminer(0);
  }

  const bilan = await synchroniserProduits(client, articles, {
    locationId, existants: geres, areactiver, statutCreation: STATUT_CREATION,
    variationPrixMax: VARIATION_PRIX_MAX, forcerPrix: args['forcer-prix'], surProgression: progression,
  });
  if (process.stdout.isTTY && articles.length) process.stdout.write('\n');
  bilan.reactives = [...areactiver].filter((r) => !bilan.erreurs.some((e) => e.ref === r));
  bilan.proteges = proteges;

  const retrait = await retirerProduits(client, aRetirer);
  bilan.retires = retrait.retires;
  bilan.erreurs.push(...retrait.erreurs);

  console.log(
    `Créés : ${bilan.crees.length}${STATUT_CREATION === 'DRAFT' ? ' (en brouillon)' : ''}   ` +
      `Mis à jour : ${bilan.misAJour.length} (dont ${bilan.reactives.length} réactivé(s))   ` +
      `Retirés : ${bilan.retires.length}   Erreurs : ${bilan.erreurs.length}`,
  );
  for (const r of bilan.retires) console.log(`  – ${r.ref} retiré : ${r.raison}`);
  for (const r of bilan.reactives) console.log(`  + ${r} remis en vente`);
  for (const p of bilan.prixBloques) {
    console.warn(`⚠ Prix non appliqué ${p.ref} : ${p.ancien} → ${p.nouveau} (${p.variation > 0 ? '+' : ''}${p.variation} %), à vérifier dans Sage (--forcer-prix pour l'appliquer)`);
  }
  for (const e of bilan.erreurs) console.error(`  ✗ ${e.ref} : ${e.message}`);

  await mkdir('sortie', { recursive: true });
  const rapport = `sortie/synchro-produits-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(rapport, JSON.stringify(bilan, null, 2), 'utf8');
  console.log(`Rapport : ${rapport}`);

  // On ne mémorise la progression que si tout est passé, pour retenter les échecs au prochain lancement.
  // Jamais avec --ref : la date avancerait au-delà d'articles modifiés mais pas encore envoyés.
  if (bilan.erreurs.length === 0 && !args.ref) {
    const max = articles.reduce((m, a) => (a.cbModification > m ? a.cbModification : m), new Date(etat.derniereModification ?? 0));
    await mkdir('etat', { recursive: true });
    await writeFile(
      FICHIER_ETAT,
      JSON.stringify({ derniereModification: max.toISOString(), perimetre, le: new Date().toISOString() }, null, 2),
    );
  }
  process.exitCode = bilan.erreurs.length || retraitBloque ? 1 : 0;
} catch (err) {
  if ('finAnticipee' in err) process.exitCode = err.finAnticipee;
  else {
    console.error(`Erreur : ${err.message}`);
    process.exitCode = 1;
  }
} finally {
  await pool?.close();
}
