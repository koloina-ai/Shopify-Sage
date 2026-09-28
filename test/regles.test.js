// Tests des règles de protection de la boutique : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  controlePrix, estProduitConnecteur, etiquettesGerees, fusionEtiquettes, handleArticle, misesAZeroSuspectes,
  lireEtiquettesEnregistrees,
} from '../src/regles.js';

test('handle : adresse Shopify stable dérivée de la référence Sage', () => {
  assert.equal(handleArticle('03520224'), 'sage-03520224');
  assert.equal(handleArticle('ZF1AEX/MPEMB/8.5'), 'sage-zf1aex-mpemb-8-5');
});

test('propriété : seuls les produits créés par le connecteur sont reconnus', () => {
  assert.equal(estProduitConnecteur({ handle: 'sage-03520224', sku: '03520224', arRef: '03520224' }), true);
  assert.equal(estProduitConnecteur({ handle: 'mon-produit', sku: '03520224', arRef: '03520224' }), false, 'créé à la main');
  assert.equal(estProduitConnecteur({ handle: 'sage-03520224', sku: '03520224', arRef: null }), false, 'sans référence Sage');
  assert.equal(estProduitConnecteur({ handle: 'sage-03520224', sku: 'AUTRE', arRef: '03520224' }), false, 'SKU modifié');
});

test('étiquettes : celles ajoutées par SODICO sont toujours conservées', () => {
  const actuelles = ['sage', '03AMB', 'ACCESSOIRES', 'promo-noel', 'coup-de-coeur'];
  const { ajouter, retirer } = fusionEtiquettes(actuelles, ['sage', '03AMB', 'ACCESSOIRES'], ['sage', '03AMB', 'VISSERIE']);
  assert.deepEqual(ajouter, ['VISSERIE']);
  assert.deepEqual(retirer, ['ACCESSOIRES'], 'seule l\'ancienne étiquette du connecteur part');
});

test('étiquettes : sans historique, rien n\'est retiré', () => {
  const { ajouter, retirer } = fusionEtiquettes(['sage', 'promo'], null, ['sage', '03AMB']);
  assert.deepEqual(ajouter, ['03AMB']);
  assert.deepEqual(retirer, []);
});

test('étiquettes : les étiquettes spéciales ne sont jamais retirées par la fusion', () => {
  const { retirer } = fusionEtiquettes(['sage', 'sage-ignorer', 'sage-retire'], ['sage', 'sage-ignorer', 'sage-retire'], ['sage']);
  assert.deepEqual(retirer, []);
});

test('étiquettes gérées : sage + famille + statistique, sans doublon ni vide', () => {
  assert.deepEqual(etiquettesGerees({ FA_CodeFamille: '03AMB', AR_Stat04: 'ACCESSOIRES' }), ['sage', '03AMB', 'ACCESSOIRES']);
  assert.deepEqual(etiquettesGerees({ FA_CodeFamille: '03AMB', AR_Stat04: '' }), ['sage', '03AMB']);
});

test('garde-fou prix', () => {
  assert.equal(controlePrix(10, 12, 0.5).appliquer, true, '+20 % appliqué');
  assert.equal(controlePrix(10, 4, 0.5).appliquer, false, '-60 % bloqué');
  assert.equal(controlePrix(10, 100, 0.5).appliquer, false, 'x10 (faute de frappe) bloqué');
  assert.equal(controlePrix(10, 1000, 0).appliquer, true, 'garde-fou désactivé');
  assert.equal(controlePrix(0, 5, 0.5).appliquer, true, 'pas de prix précédent');
});

test('garde-fou stocks : quelques ruptures passent, une mise à zéro massive est bloquée', () => {
  const ecarts = (n) => Array.from({ length: n }, (_, i) => ({ sku: `A${i}`, disponible: 10, sage: 0 }));
  assert.equal(misesAZeroSuspectes(ecarts(3), 100).length, 0, '3 ruptures sur 100 : normal');
  assert.equal(misesAZeroSuspectes(ecarts(20), 100).length, 0, '20 % : encore accepté');
  assert.equal(misesAZeroSuspectes(ecarts(21), 100).length, 21, 'au-delà de 20 % : bloqué');
  assert.equal(misesAZeroSuspectes(ecarts(5), 10).length, 0, 'petit catalogue : jusqu\'à 5 toujours accepté');
  assert.equal(misesAZeroSuspectes([{ disponible: 0, sage: 0 }], 1).length, 0, 'déjà à 0');
});

test('lecture de l\'historique des étiquettes', () => {
  assert.deepEqual(lireEtiquettesEnregistrees('["sage","03AMB"]'), ['sage', '03AMB']);
  assert.equal(lireEtiquettesEnregistrees('null'), null);
  assert.equal(lireEtiquettesEnregistrees('pas du json'), null);
});
