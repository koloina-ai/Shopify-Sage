// Tests du catalogue par famille (1 famille Sage = 1 produit, 1 article = 1 variante) : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { handleFamille, planifierCatalogue, versFamilleShopify, versMisesAJour, versNouvellesVariantes } from '../src/familles.js';

const article = (ref, design, prix, autres = {}) => ({
  AR_Ref: ref, AR_Design: design, AR_PrixVen: prix, AR_CodeBarre: '', FA_CodeFamille: '05INJPO', AR_Sommeil: 0, stock_dispo: 100, ...autres,
});
const variante = (sku, option, prix, autres = {}) => ({
  varianteId: `gid://v/${sku}`, sku, prix, codeBarre: null, option, designationSage: option, inventoryItemId: `gid://i/${sku}`,
  suivi: true, disponible: 5, ...autres,
});
const famille = (code, variantes, autres = {}) => ({
  produitId: `gid://p/${code}`, handle: handleFamille(code), code, statut: 'ACTIVE', tags: ['sage', code], optionNom: 'Article',
  ignore: false, proprietaire: true, variantes, ...autres,
});

test('adresse de famille stable', () => {
  assert.equal(handleFamille('05INJPO'), 'famille-05injpo');
  assert.equal(handleFamille('04BQPSE'), 'famille-04bqpse');
});

test('famille absente : créée avec ses articles actifs et à prix, sans les autres', () => {
  const plan = planifierCatalogue([
    article('A1', 'POT 125 ML', 290.4),
    article('A2', 'POT 300 ML', 0), // pas de prix : pas créé, signalé
    article('A3', 'POT 500 ML', 12, { AR_Sommeil: 1 }), // en sommeil, jamais en ligne : ignoré
  ], []);
  assert.equal(plan.creations.length, 1);
  assert.deepEqual(plan.creations[0].variantes.map((v) => v.article.AR_Ref), ['A1']);
  assert.ok(plan.signalements.some((s) => s.ref === 'A2' && /pas de prix/.test(s.raison)));
  assert.equal(plan.signalements.some((s) => s.ref === 'A3'), false);
});

test('création : variante suivie en stock, pas de vente au-delà, SKU = référence Sage', () => {
  const plan = planifierCatalogue([article('A1', 'POT 125 ML', 290.4, { stock_dispo: 12.7 })], []);
  const p = versFamilleShopify('05INJPO', plan.creations[0].variantes, { locationId: 'loc' });
  assert.equal(p.handle, 'famille-05injpo');
  assert.equal(p.title, 'Famille 05INJPO');
  assert.deepEqual(p.tags, ['sage', '05INJPO']);
  const v = p.variants[0];
  assert.equal(v.sku, 'A1');
  assert.equal(v.price, '290.40');
  assert.equal(v.inventoryPolicy, 'DENY');
  assert.equal(v.inventoryItem.tracked, true);
  assert.equal(v.inventoryQuantities[0].quantity, 12);
});

test('désignations en double dans une famille : rendues uniques avec la référence', () => {
  const plan = planifierCatalogue([article('A1', 'POT', 1), article('A2', 'POT', 2)], []);
  assert.deepEqual(plan.creations[0].variantes.map((v) => v.option), ['POT', 'POT (A2)']);
});

test('famille existante : seuls les nouveaux articles sont ajoutés', () => {
  const plan = planifierCatalogue(
    [article('A1', 'POT 125 ML', 290.4), article('A9', 'POT 1 L', 50)],
    [famille('05INJPO', [variante('A1', 'POT 125 ML', 290.4)])],
  );
  assert.equal(plan.creations.length, 0);
  assert.deepEqual(plan.ajouts[0].variantes.map((v) => v.article.AR_Ref), ['A9']);
  const entree = versNouvellesVariantes(plan.ajouts[0].variantes, { optionNom: 'Article', locationId: 'loc' })[0];
  assert.equal(entree.inventoryItem.sku, 'A9');
  assert.equal(entree.inventoryQuantities[0].availableQuantity, 100);
});

test('mise à jour : seulement ce qui change (prix, code-barre)', () => {
  const plan = planifierCatalogue(
    [article('A1', 'POT 125 ML', 300, { AR_CodeBarre: '3468050523608' })],
    [famille('05INJPO', [variante('A1', 'POT 125 ML', 290.4)])],
  );
  assert.deepEqual(plan.majs[0].variantes[0].changements, { price: '300.00', barcode: '3468050523608' });
  const entree = versMisesAJour(plan.majs[0].variantes, { optionNom: 'Article' })[0];
  assert.deepEqual(Object.keys(entree).sort(), ['barcode', 'id', 'price']);
});

test('rien ne change : aucune mise à jour', () => {
  const plan = planifierCatalogue([article('A1', 'POT 125 ML', 290.4)], [famille('05INJPO', [variante('A1', 'POT 125 ML', 290.4)])]);
  assert.equal(plan.majs.length + plan.ajouts.length + plan.creations.length, 0);
});

test('prix à 0 dans Sage : prix Shopify conservé et signalé', () => {
  const plan = planifierCatalogue([article('A1', 'POT', 0)], [famille('05INJPO', [variante('A1', 'POT', 290.4)])]);
  assert.equal(plan.majs.length, 0);
  assert.ok(plan.signalements.some((s) => /prix Shopify conservé/.test(s.raison)));
});

test('prix qui s\'envole : non appliqué, signalé', () => {
  const plan = planifierCatalogue([article('A1', 'POT', 2904)], [famille('05INJPO', [variante('A1', 'POT', 290.4)])]);
  assert.equal(plan.majs.length, 0);
  assert.equal(plan.prixBloques[0].ref, 'A1');
  const force = planifierCatalogue([article('A1', 'POT', 2904)], [famille('05INJPO', [variante('A1', 'POT', 290.4)])], { forcerPrix: true });
  assert.equal(force.majs[0].variantes[0].changements.price, '2904.00');
});

test('désignation : mise à jour seulement si SODICO ne l\'a pas renommée dans Shopify', () => {
  const nonRenommee = planifierCatalogue([article('A1', 'POT 125 ML NEUF', 1)], [famille('05INJPO', [variante('A1', 'POT 125 ML', 1)])]);
  assert.equal(nonRenommee.majs[0].variantes[0].changements.option, 'POT 125 ML NEUF');
  const renommee = planifierCatalogue(
    [article('A1', 'POT 125 ML NEUF', 1)],
    [famille('05INJPO', [variante('A1', '125 ml transparent', 1, { designationSage: 'POT 125 ML' })])],
  );
  assert.equal(renommee.majs.length, 0, 'le libellé choisi par SODICO est conservé');
});

test('article en sommeil déjà en ligne : signalé (le stock passe à 0 par l\'étape stocks), rien supprimé', () => {
  const plan = planifierCatalogue([article('A1', 'POT', 1, { AR_Sommeil: 1 })], [famille('05INJPO', [variante('A1', 'POT', 1)])]);
  assert.ok(plan.signalements.some((s) => s.ref === 'A1' && /sommeil/.test(s.raison)));
  assert.equal(plan.majs.length, 0);
});

test('famille protégée (sage-ignorer) : non modifiée', () => {
  const plan = planifierCatalogue([article('A1', 'POT', 2), article('A2', 'BOL', 3)], [famille('05INJPO', [variante('A1', 'POT', 1)], { ignore: true })]);
  assert.equal(plan.majs.length + plan.ajouts.length + plan.creations.length, 0);
});

test('produit de même adresse non créé par le connecteur : jamais écrasé', () => {
  const plan = planifierCatalogue([article('A1', 'POT', 2)], [famille('05INJPO', [], { proprietaire: false, code: null })]);
  assert.equal(plan.creations.length, 0);
  assert.ok(plan.signalements.some((s) => /sans avoir été créé par le connecteur/.test(s.raison)));
});

test('article qui a changé de famille dans Sage : pas de doublon, signalé', () => {
  const plan = planifierCatalogue(
    [article('A1', 'POT', 2, { FA_CodeFamille: '04BQPSE' })],
    [famille('05INJPO', [variante('A1', 'POT', 2)]), famille('04BQPSE', [])],
  );
  assert.equal(plan.ajouts.length, 0);
  assert.ok(plan.signalements.some((s) => /déjà dans la famille 05INJPO/.test(s.raison)));
});

test('variante Shopify sans article Sage : non modifiée, signalée', () => {
  const plan = planifierCatalogue([article('A1', 'POT', 2)], [famille('05INJPO', [variante('A1', 'POT', 2), variante('ZZ', 'AUTRE', 1)])]);
  assert.ok(plan.signalements.some((s) => s.ref === 'ZZ'));
});
