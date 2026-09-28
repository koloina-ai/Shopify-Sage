// Module « commandes Shopify -> Sage ». Interrupteur : COMMANDES_MODE dans .env
//   off             désactivé (par défaut) : l'étape ne fait rien
//   tampon          option A : dépôt dans la base SODICO_CONNECTEUR
//   objets-metiers  option B : création directe dans Sage via les Objets Métiers (OM_SIMULATION=oui pour tester sans Sage)

import { creerIntegrateurTampon } from './integrateurs/tampon.js';
import { creerIntegrateurObjetsMetiers } from './integrateurs/objets-metiers.js';

const INTEGRATEURS = {
  tampon: creerIntegrateurTampon,
  'objets-metiers': creerIntegrateurObjetsMetiers,
};

export const modeCommandes = () => (process.env.COMMANDES_MODE || 'off').trim().toLowerCase();

export const MODES = ['off', ...Object.keys(INTEGRATEURS)];

/**
 * Contrat commun des intégrateurs :
 *   ouvrir({ poolSage })  prépare la cible (poolSage : connexion Sage en lecture seule)
 *   deposer(commande)     -> { deja, reference, etiquette? } ; idempotent ; lève une erreur si la commande échoue
 *   fermer()
 * @returns {null | { nom: string, ouvrir(ctx): Promise<void>, deposer(c): Promise<{deja: boolean, reference: string, etiquette?: string}>, fermer(): Promise<void> }}
 */
export function creerIntegrateur(mode = modeCommandes()) {
  if (mode === 'off') return null;
  const fabrique = INTEGRATEURS[mode];
  if (!fabrique) throw new Error(`COMMANDES_MODE inconnu « ${mode} » : valeurs possibles off, ${Object.keys(INTEGRATEURS).join(', ')}`);
  return fabrique();
}

export { preparerCommande } from './preparation.js';
export { lireCommandesATransmettre, marquerTransmise, ETIQUETTE_TRANSMISE, ETIQUETTE_A_VERIFIER } from './shopify.js';
