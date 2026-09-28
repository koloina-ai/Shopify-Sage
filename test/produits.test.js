// Tests de la conversion Sage -> Shopify et du contenu des mises à jour : npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { miseAJourProduit, versProduitShopify } from '../src/produits.js';
import { ean13Valide } from '../src/sage.js';
import { csvArticles } from '../src/suivi.js';

const article = {
  AR_Ref: '03520224', AR_Design: 'TENDEUR GALVA 120x60x50 ', AR_PrixVen: 10.0662, AR_CodeBarre: '3468050000475',
  FA_CodeFamille: '03AMB', AR_Stat02: 'ISOLATION', AR_Stat04: 'ACCESSOIRES', AR_PoidsBrut: 0.5, AR_PoidsNet: 0,
  AR_UnitePoids: 2, stock_dispo: 272.5, cbModification: new Date('2026-09-24T17:47:59Z'),
};
const existant = {
  produitId: 'gid://shopify/Product/1', varianteId: 'gid://shopify/ProductVariant/1', prix: 10.07,
  tags: ['sage', '03AMB', 'ACCESSOIRES', 'promo-noel'], etiquettesConnecteur: ['sage', '03AMB', 'ACCESSOIRES'],
};

test('création : produit complet, stock initial arrondi, pas de vente au-delà du stock', () => {
  const p = versProduitShopify(article, { locationId: 'loc', statut: 'ACTIVE' });
  assert.equal(p.handle, 'sage-03520224');
  assert.equal(p.title, 'TENDEUR GALVA 120x60x50');
  assert.equal(p.variants[0].price, '10.07');
  assert.equal(p.variants[0].inventoryPolicy, 'DENY');
  assert.equal(p.variants[0].inventoryQuantities[0].quantity, 272);
  assert.deepEqual(p.variants[0].inventoryItem.measurement, { weight: { value: 0.5, unit: 'KILOGRAMS' } });
  assert.ok(p.metafields.some((m) => m.key === 'etiquettes'));
});

test('création en brouillon si demandé', () => {
  assert.equal(versProduitShopify(article, { locationId: 'loc', statut: 'DRAFT' }).status, 'DRAFT');
});

test('mise à jour : ne touche ni au statut, ni aux photos, ni à la description, ni au SEO', () => {
  const { document, variables } = miseAJourProduit(article, existant);
  assert.equal('status' in variables.produit, false, 'statut choisi par SODICO conservé');
  for (const champ of ['descriptionHtml', 'seo', 'media', 'files', 'handle', 'tags']) {
    assert.equal(champ in variables.produit, false, `${champ} non envoyé`);
  }
  assert.equal(/productSet/.test(document), false, 'pas de remplacement complet du produit');
  assert.equal('compareAtPrice' in variables.variantes[0], false, 'prix barré (promo) conservé');
});

test('mise à jour : les étiquettes ajoutées par SODICO sont conservées', () => {
  const { variables } = miseAJourProduit({ ...article, AR_Stat04: 'VISSERIE' }, existant);
  assert.deepEqual(variables.ajouter, ['VISSERIE']);
  assert.deepEqual(variables.retirer, ['ACCESSOIRES']);
  assert.equal(variables.retirer.includes('promo-noel'), false);
});

test('mise à jour : les champs sont ajoutés un par un (metafieldsSet), sans effacer les autres', () => {
  const { document, variables } = miseAJourProduit(article, existant);
  assert.match(document, /metafieldsSet/);
  assert.ok(variables.metafields.every((m) => m.namespace === 'sage' && m.ownerId === existant.produitId));
});

test('mise à jour : remise en vente seulement sur demande, et retrait de la marque sage-retire', () => {
  const { variables } = miseAJourProduit(article, { ...existant, tags: [...existant.tags, 'sage-retire'] }, { reactiver: true });
  assert.equal(variables.produit.status, 'ACTIVE');
  assert.ok(variables.retirer.includes('sage-retire'));
});

test('mise à jour : un prix qui s\'envole n\'est pas appliqué', () => {
  const { variables, prixBloque } = miseAJourProduit({ ...article, AR_PrixVen: 1006.62 }, existant);
  assert.equal('price' in variables.variantes[0], false);
  assert.equal(prixBloque.ref, '03520224');
  const force = miseAJourProduit({ ...article, AR_PrixVen: 1006.62 }, existant, { forcerPrix: true });
  assert.equal(force.variables.variantes[0].price, '1006.62');
  assert.equal(force.prixBloque, null);
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
