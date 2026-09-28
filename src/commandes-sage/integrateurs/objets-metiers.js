// Intégrateur B — Objets Métiers Sage 100 : crée directement le bon de commande dans Sage, via le pont PowerShell
// (Node.js ne parle pas aux composants COM de Sage). Le pont est lancé une fois pour toute l'étape.
//
// Réglages (.env) : OM_FICHIER_MAE, OM_FICHIER_GCM, OM_UTILISATEUR, OM_MOT_DE_PASSE, OM_SOUCHE, OM_DEPOT, OM_PRIX,
//                   OM_PREFIXE_REF (défaut WEB), OM_ARCHITECTURE (32 par défaut | 64), OM_DELAI_MS, OM_SIMULATION=oui

import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import sql from 'mssql/msnodesqlv8.js';
import { ETIQUETTE_A_VERIFIER } from '../shopify.js';

const PONT = fileURLToPath(new URL('../objets-metiers/pont.ps1', import.meta.url));
const DELAI_MS = Number(process.env.OM_DELAI_MS) || 60_000;

// Les Objets Métiers sont souvent en 32 bits : il faut alors le PowerShell 32 bits pour les charger.
function cheminPowerShell() {
  const racine = process.env.SystemRoot || 'C:\\Windows';
  return process.env.OM_ARCHITECTURE === '64'
    ? `${racine}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe`
    : `${racine}\\SysWOW64\\WindowsPowerShell\\v1.0\\powershell.exe`;
}

/** Référence de la pièce Sage (DO_Ref, 17 caractères) : préfixe + numéro Shopify, ex. WEB1004. */
export const referencePiece = (numeroShopify) => `${process.env.OM_PREFIXE_REF ?? 'WEB'}${numeroShopify.replace(/^#/, '')}`;

export function creerIntegrateurObjetsMetiers() {
  let pont;
  let lignes;
  let poolSage;
  let antiDoublon = true;
  const simulation = process.env.OM_SIMULATION === 'oui';

  // Envoie une requête au pont et attend sa réponse (une seule requête à la fois).
  function demander(requete) {
    return new Promise((resolve, reject) => {
      const minuteur = setTimeout(() => {
        pont.kill();
        reject(new Error(`le pont Objets Métiers ne répond plus (${DELAI_MS / 1000} s)`));
      }, DELAI_MS);
      lignes.once('line', (ligne) => {
        clearTimeout(minuteur);
        try {
          resolve(JSON.parse(ligne));
        } catch {
          reject(new Error(`réponse illisible du pont : ${ligne.slice(0, 200)}`));
        }
      });
      pont.stdin.write(JSON.stringify(requete) + '\n');
    });
  }

  /** Pièce déjà créée dans Sage pour cette commande (relance après une coupure) : lecture seule de F_DOCENTETE. */
  async function pieceExistante(reference, ctNum) {
    if (!antiDoublon) return null;
    const { recordset } = await poolSage.request()
      .input('ref', sql.VarChar(17), reference)
      .input('tiers', sql.VarChar(17), ctNum)
      .query(`IF OBJECT_ID('dbo.F_DOCENTETE') IS NULL SELECT CAST(NULL AS VARCHAR(13)) AS DO_Piece, 0 AS table_ok
              ELSE SELECT TOP 1 DO_Piece, 1 AS table_ok FROM dbo.F_DOCENTETE
                   WHERE DO_Domaine = 0 AND DO_Type = 1 AND DO_Ref = @ref AND DO_Tiers = @tiers`);
    if (recordset[0] && !recordset[0].table_ok) {
      antiDoublon = false;
      console.warn('⚠ Table F_DOCENTETE absente (base de test) : contrôle anti-doublon côté Sage désactivé');
      return null;
    }
    return recordset[0]?.DO_Piece ?? null;
  }

  return {
    nom: `Objets Métiers Sage${simulation ? ' (SIMULATION : rien n\'est créé dans Sage)' : ''}`,

    async ouvrir(contexte = {}) {
      poolSage = contexte.poolSage;
      if (!poolSage) throw new Error('connexion Sage requise pour l\'intégrateur Objets Métiers');
      pont = spawn(cheminPowerShell(), ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', PONT], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      let erreurLancement = null;
      pont.on('error', (err) => {
        erreurLancement = err;
      });
      pont.stderr.on('data', (d) => console.error(`pont OM : ${d.toString().trim()}`));
      lignes = createInterface({ input: pont.stdout });
      const r = await demander({ action: 'ouvrir' }).catch((err) => {
        throw erreurLancement ?? err;
      });
      if (!r.ok) throw new Error(`ouverture de la société Sage impossible : ${r.erreur}`);
      console.log(`  ${r.message}`);
    },

    /** @param {import('../preparation.js').CommandeSage} c */
    async deposer(c) {
      // Une commande incomplète n'est pas créée dans Sage : elle est marquée « à vérifier » dans Shopify
      // (étiquette sage-a-verifier) pour être corrigée puis relancée en retirant l'étiquette.
      if (c.statut === 'A_VERIFIER') return { deja: false, reference: 'non créée dans Sage', etiquette: ETIQUETTE_A_VERIFIER };

      const reference = referencePiece(c.numeroShopify);
      const existante = await pieceExistante(reference, c.ctNum);
      if (existante) return { deja: true, reference: `pièce Sage ${existante}` };

      const r = await demander({
        action: 'creer',
        commande: {
          reference,
          ctNum: c.ctNum,
          date: c.date.toISOString(),
          lignes: c.lignes.map((l) => ({ numero: l.numero, arRef: l.arRef, quantite: l.quantite, prixUnitaire: l.prixUnitaire })),
        },
      });
      if (!r.ok) throw new Error(r.erreur);
      return { deja: false, reference: `pièce Sage ${r.piece}` };
    },

    async fermer() {
      if (!pont || pont.exitCode !== null) return;
      await demander({ action: 'fermer' }).catch(() => {});
      pont.stdin.end();
    },
  };
}
