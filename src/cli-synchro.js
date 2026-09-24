// Synchro complète Sage -> Shopify : npm run synchro -- [--poc] [--tout] [--simulation]
// 1. produits : crée les produits manquants et met à jour ceux modifiés dans Sage
// 2. stocks   : corrige les stocks qui diffèrent de Sage
// L'étape 2 est lancée même si l'étape 1 a rencontré des erreurs.

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
if (args.includes('--help')) {
  console.log(`
Usage : npm run synchro -- [options]

  (sans option)   produits modifiés depuis la dernière synchro, puis tous les stocks
  --poc           limite les produits au périmètre « prêts POC »
  --tout          renvoie tous les produits publiables
  --simulation    n'envoie rien à Shopify
`);
  process.exit(0);
}

const etapes = [
  { titre: 'Produits', script: 'cli-produits.js', args: args.filter((a) => ['--poc', '--tout', '--simulation'].includes(a)) },
  { titre: 'Stocks', script: 'cli-stocks.js', args: args.filter((a) => a === '--simulation') },
];

const debut = Date.now();
console.log(`=== Synchro Sage -> Shopify — ${new Date().toLocaleString('fr-FR')} ===`);
const resultats = etapes.map(({ titre, script, args: argsEtape }, i) => {
  console.log(`\n--- ${i + 1}/${etapes.length} ${titre} ---`);
  // Le process enfant hérite des variables déjà chargées depuis .env / env.local.
  const { status } = spawnSync(process.execPath, [fileURLToPath(new URL(script, import.meta.url)), ...argsEtape], {
    stdio: 'inherit',
  });
  return { titre, ok: status === 0 };
});

console.log(`\n=== Terminé en ${((Date.now() - debut) / 1000).toFixed(1)} s : ${resultats.map((r) => `${r.titre} ${r.ok ? '✓' : '✗'}`).join('   ')} ===`);
process.exitCode = resultats.every((r) => r.ok) ? 0 : 1;
