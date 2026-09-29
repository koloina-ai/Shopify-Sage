// Tests des garde-fous de protection de la boutique : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { controlePrix, misesAZeroSuspectes } from '../src/regles.js';
import { ean13Valide } from '../src/sage.js';
import { csvArticles } from '../src/suivi.js';
import { quantiteStock } from '../src/stocks.js';

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

test('stock : entier, jamais négatif', () => {
  assert.equal(quantiteStock(272.5), 272);
  assert.equal(quantiteStock(-4), 0);
});

test('EAN-13', () => {
  assert.equal(ean13Valide('3468050523608'), true);
  assert.equal(ean13Valide('3468050000347'), false);
  assert.equal(ean13Valide('123'), false);
});

test('export Excel : formules neutralisées', () => {
  const ligne = csvArticles([{ ref: 'A', designation: '=HYPERLINK("x")', raison: '+1', aCorriger: 'ok' }]).split('\r\n')[1];
  assert.equal(ligne, '"A";"\'=HYPERLINK(""x"")";"\'+1";"ok"');
});
