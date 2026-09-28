// Voir ou changer le mode de synchro des commandes :
//   npm run commandes-mode                    affiche le mode actuel et vérifie que chaque mode est prêt
//   npm run commandes-mode -- tampon          bascule en option A (zone tampon)
//   npm run commandes-mode -- objets-metiers  bascule en option B (Objets Métiers)
//   npm run commandes-mode -- off             désactive l'étape commandes
// La bascule n'a lieu que si le mode visé est prêt (sauf --forcer). Seule la ligne COMMANDES_MODE du .env est modifiée.

import { parseArgs } from 'node:util';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import sql from 'mssql/msnodesqlv8.js';
import { connecterSage } from './sage.js';
import { creerIntegrateur, MODES, modeCommandes } from './commandes-sage/index.js';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
const FICHIER_ENV = process.env.FICHIER_ENV || path.join(RACINE, '.env');

const DESCRIPTIONS = {
  off: 'désactivé : les commandes Shopify ne sont pas transmises à Sage',
  tampon: 'option A : dépôt dans la zone tampon SODICO_CONNECTEUR, intégrée ensuite dans Sage par M2I',
  'objets-metiers': 'option B : création directe des bons de commande dans Sage (Objets Métiers)',
};

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: { forcer: { type: 'boolean', default: false } } });

/** Vérifie qu'un mode peut fonctionner : { ok, detail } */
async function verifier(mode) {
  if (mode === 'off') return { ok: true, detail: 'rien à vérifier' };
  let poolSage;
  const integrateur = creerIntegrateur(mode);
  try {
    poolSage = await connecterSage();
    await integrateur.ouvrir({ poolSage });
    return { ok: true, detail: integrateur.nom };
  } catch (err) {
    return { ok: false, detail: err.message };
  } finally {
    await integrateur.fermer().catch(() => {});
    await poolSage?.close().catch(() => {});
  }
}

/** Commandes déposées dans la zone tampon et pas encore intégrées dans Sage (null si la zone est inaccessible). */
async function enAttenteDansTampon() {
  let pool;
  try {
    pool = await new sql.ConnectionPool({
      connectionString: process.env.COMMANDES_SQL_CONNECTION ||
        'Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=SODICO_CONNECTEUR;Trusted_Connection=yes;TrustServerCertificate=yes;',
    }).connect();
    const { recordset } = await pool.request().query(`SELECT COUNT(*) AS n FROM dbo.CMD_ENTETE WHERE statut = 'A_INTEGRER'`);
    return recordset[0].n;
  } catch {
    return null;
  } finally {
    await pool?.close().catch(() => {});
  }
}

async function ecrireMode(mode) {
  const contenu = await readFile(FICHIER_ENV, 'utf8').catch(() => '');
  const ligne = `COMMANDES_MODE=${mode}`;
  const nouveau = /^\s*COMMANDES_MODE\s*=.*$/m.test(contenu)
    ? contenu.replace(/^\s*COMMANDES_MODE\s*=.*$/m, ligne)
    : `${contenu}${contenu && !contenu.endsWith('\n') ? '\n' : ''}${ligne}\n`;
  await writeFile(FICHIER_ENV, nouveau, 'utf8');
}

try {
  const actuel = modeCommandes();
  const cible = positionals[0]?.trim().toLowerCase();

  if (!cible) {
    console.log(`Mode actuel : ${actuel} — ${DESCRIPTIONS[actuel] ?? 'inconnu'}\n`);
    for (const mode of MODES) {
      const { ok, detail } = await verifier(mode);
      console.log(`  ${ok ? '✓' : '✗'} ${mode.padEnd(15)} ${ok ? 'prêt' : 'pas prêt'} — ${detail}`);
    }
    console.log('\nPour changer : npm run commandes-mode -- <off | tampon | objets-metiers>');
  } else {
    if (!MODES.includes(cible)) throw new Error(`mode inconnu « ${cible} » : ${MODES.join(', ')}`);
    if (cible === actuel) {
      console.log(`Déjà en mode ${cible}.`);
    } else {
      const { ok, detail } = await verifier(cible);
      if (!ok && !args.forcer) {
        throw new Error(`le mode ${cible} n'est pas prêt : ${detail}\n  Rien n'a été changé (--forcer pour basculer quand même).`);
      }
      if (actuel === 'tampon') {
        const n = await enAttenteDansTampon();
        if (n) console.warn(`⚠ ${n} commande(s) de la zone tampon attendent encore leur intégration dans Sage : elles restent à traiter par l'import de M2I (elles ne seront pas reprises par le nouveau mode).`);
      }
      await ecrireMode(cible);
      console.log(`✓ Mode des commandes : ${actuel} → ${cible} (${DESCRIPTIONS[cible]})`);
      console.log(`  Pris en compte à la prochaine synchro. Retour arrière : npm run commandes-mode -- ${actuel}`);
    }
  }
} catch (err) {
  console.error(`Erreur : ${err.message}`);
  process.exitCode = 1;
}
