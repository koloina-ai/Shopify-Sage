// Synchro des commandes Shopify -> Sage : npm run commandes-sage -- [--simulation]
// Mode choisi par COMMANDES_MODE (off | tampon | objets-metiers). Chaque commande est traitée isolément :
// une commande en erreur n'empêche pas les autres, et elle est retentée au passage suivant.

import { parseArgs } from 'node:util';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { articlesExistants, clientsExistants, connecterSage } from './sage.js';
import { creerIntegrateur, lireCommandesATransmettre, marquerTransmise, modeCommandes, preparerCommande } from './commandes-sage/index.js';

const FICHIER_ETAT = 'etat/commandes-sage.json';
const JOURS_REPRISE_INITIALE = 7; // au tout premier lancement : commandes des 7 derniers jours (ou COMMANDES_DEPUIS)

const { values: args } = parseArgs({
  options: {
    simulation: { type: 'boolean', default: false },
    help: { type: 'boolean', default: false },
  },
});
if (args.help) {
  console.log(`
Usage : npm run commandes-sage -- [--simulation]

  Transmet à Sage les commandes Shopify non annulées et pas encore marquées « sage-transmise ».
  COMMANDES_MODE=off (défaut) | tampon | objets-metiers
  COMMANDES_DEPUIS=AAAA-MM-JJ           date de départ au premier lancement (défaut : 7 jours)
  COMMANDES_CLIENT_PAR_DEFAUT=<CT_Num>  client Sage des commandes sans entreprise B2B (sinon « à vérifier »)
  --simulation                          affiche ce qui serait transmis, sans rien écrire
`);
  process.exit(0);
}


const lireEtat = async () => JSON.parse(await readFile(FICHIER_ETAT, 'utf8').catch(() => '{}'));

// Fin anticipée sans process.exit() : avec le pilote SQL Windows (msnodesqlv8), process.exit() pendant qu'une
// connexion est ouverte fait planter Node à la fermeture et fausse le code retour (fausses alertes).
const terminer = (code = 0) => {
  throw Object.assign(new Error('fin'), { finAnticipee: code });
};

let pool;
let integrateur;
try {
  const mode = modeCommandes();
  if (mode === 'off') {
    console.log('Synchro des commandes désactivée (COMMANDES_MODE=off)');
    terminer(0);
  }
  integrateur = creerIntegrateur(mode);
  const etat = await lireEtat();
  const depuis = new Date(
    etat.depuis ?? process.env.COMMANDES_DEPUIS ?? Date.now() - JOURS_REPRISE_INITIALE * 24 * 3600 * 1000,
  );
  if (Number.isNaN(depuis.getTime())) throw new Error('COMMANDES_DEPUIS invalide (format attendu AAAA-MM-JJ)');
  if (!etat.depuis && !args.simulation) {
    await mkdir('etat', { recursive: true });
    await writeFile(FICHIER_ETAT, JSON.stringify({ depuis: depuis.toISOString() }, null, 2));
  }

  const client = creerClient(configShopify());
  const { commandes, avertissements } = await lireCommandesATransmettre(client, depuis);
  for (const a of avertissements) console.warn(`⚠ Shopify : ${a}`);
  console.log(`Mode « ${integrateur.nom} » : ${commandes.length} commande(s) à transmettre depuis le ${depuis.toLocaleDateString('fr-FR')}`);
  if (commandes.length === 0) terminer(0);

  // Vérifications dans Sage, en lecture seule
  pool = await connecterSage();
  const clientParDefaut = process.env.COMMANDES_CLIENT_PAR_DEFAUT?.trim() || null;
  const [articles, clients] = await Promise.all([
    // Codes trop longs exclus de la recherche : ils sont signalés par preparerCommande
    articlesExistants(pool, commandes.flatMap((c) => c.lineItems.nodes.map((l) => l.sku?.trim())).filter((r) => r?.length <= 19)),
    clientsExistants(pool, [...commandes.map((c) => c.purchasingEntity?.company?.externalId?.trim()), clientParDefaut].filter((n) => n?.length <= 17)),
  ]);
  const preparees = commandes.map((c) => preparerCommande(c, { articles, clients, clientParDefaut }));

  if (args.simulation) {
    console.table(preparees.map((c) => ({ commande: c.numeroShopify, client: c.ctNum, lignes: c.lignes.length, total: c.totaux.ttc, statut: c.statut, remarques: c.messages.join(' ; ') })));
    terminer(0);
  }

  await integrateur.ouvrir({ poolSage: pool });
  const bilan = { transmises: [], erreurs: [] };
  for (const c of preparees) {
    try {
      const { deja, reference, etiquette } = await integrateur.deposer(c);
      // Marquage Shopify après le dépôt : s'il échoue, la commande reviendra au passage suivant,
      // et deposer() la reconnaîtra (pas de doublon).
      await marquerTransmise(client, c.shopifyId, etiquette);
      bilan.transmises.push({ commande: c.numeroShopify, statut: c.statut, reference, deja, messages: c.messages });
      console.log(`  ${c.statut === 'A_INTEGRER' ? '✓' : '⚠'} ${c.numeroShopify} -> ${reference}${deja ? ' (déjà déposée)' : ''}` +
        `${c.statut === 'A_VERIFIER' ? ` — à vérifier : ${c.messages.join(' ; ')}` : ''}`);
    } catch (err) {
      bilan.erreurs.push({ commande: c.numeroShopify, message: err.message });
      console.error(`  ✗ ${c.numeroShopify} : ${err.message}`);
    }
  }

  const aVerifier = bilan.transmises.filter((t) => t.statut === 'A_VERIFIER').length;
  console.log(`Commandes transmises : ${bilan.transmises.length} (dont ${aVerifier} à vérifier)   Erreurs : ${bilan.erreurs.length}`);

  await mkdir('sortie', { recursive: true });
  const rapport = `sortie/synchro-commandes-${new Date().toISOString().replace(/[:.]/g, '-')}.json`;
  await writeFile(rapport, JSON.stringify(bilan, null, 2), 'utf8');
  console.log(`Rapport : ${rapport}`);
  process.exitCode = bilan.erreurs.length ? 1 : 0;
} catch (err) {
  if ('finAnticipee' in err) process.exitCode = err.finAnticipee;
  else {
    console.error(`Erreur : ${err.message}`);
    process.exitCode = 1;
  }
} finally {
  await integrateur?.fermer().catch(() => {});
  await pool?.close();
}
