// Vérifie la configuration e-mail : npm run test-email
// Envoie un e-mail de test à ALERTE_A avec les réglages SMTP du .env.

import { configEmail, envoyerEmail, gabaritHtml } from './email.js';

const config = configEmail();
if (!config.actif) {
  console.error('Configuration incomplète : renseigner SMTP_HOST et ALERTE_A dans le fichier .env');
  process.exit(1);
}
console.log(`Serveur : ${config.host}:${config.port} (${config.secure ? 'SSL' : 'STARTTLS'})  compte : ${config.user ?? '(aucun)'}`);
console.log(`Destinataire(s) : ${config.destinataires.join(', ')}`);

try {
  const compteRendu = await envoyerEmail({
    sujet: '🔧 Connecteur Sage-Shopify : e-mail de test',
    texte: `Si vous lisez ce message, les alertes e-mail du connecteur fonctionnent.\nEnvoyé le ${new Date().toLocaleString('fr-FR')}.`,
    html: gabaritHtml(
      'E-mail de test',
      '#1565c0',
      `<p>Si vous lisez ce message, les alertes e-mail du connecteur fonctionnent.</p>
       <p style="color:#666">Envoyé le ${new Date().toLocaleString('fr-FR')}.</p>`,
    ),
  });
  console.log(`✓ ${compteRendu}`);
} catch (err) {
  console.error(`✗ Échec : ${err.message}`);
  if (/Invalid login|Username and Password not accepted|535/i.test(err.message)) {
    console.error('  → Identifiant ou mot de passe refusé. Avec Google, il faut un « mot de passe d\'application », pas le mot de passe habituel.');
  } else if (/ECONNREFUSED|ETIMEDOUT|ENOTFOUND|EAI_AGAIN/i.test(err.message)) {
    console.error('  → Serveur injoignable : vérifier SMTP_HOST / SMTP_PORT, ou un pare-feu qui bloque le port.');
  }
  process.exitCode = 1;
}
