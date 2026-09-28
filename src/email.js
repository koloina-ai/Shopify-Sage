// Envoi d'e-mails (alertes, résumé quotidien).
// SMTP_HOST=fichier : mode test, les e-mails sont écrits dans sortie/emails/*.eml au lieu d'être envoyés.

import nodemailer from 'nodemailer';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';

export function configEmail() {
  const destinataires = (process.env.ALERTE_A || '').split(/[,;]/).map((s) => s.trim()).filter(Boolean);
  return {
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT) || 465,
    secure: (process.env.SMTP_SECURE ?? 'true') !== 'false',
    user: process.env.SMTP_USER,
    password: process.env.SMTP_PASSWORD,
    de: process.env.ALERTE_DE || process.env.SMTP_USER,
    destinataires,
    actif: Boolean(process.env.SMTP_HOST && destinataires.length),
  };
}

/**
 * @param {{ sujet: string, texte: string, html: string, piecesJointes?: { filename: string, content: string }[] }} message
 * @returns {Promise<string>} description de ce qui a été fait (pour le journal)
 */
export async function envoyerEmail({ sujet, texte, html, piecesJointes = [] }) {
  const config = configEmail();
  if (!config.actif) return 'e-mail non envoyé : SMTP_HOST ou ALERTE_A non configuré';

  const modeFichier = config.host === 'fichier';
  const transport = modeFichier
    ? nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' })
    : nodemailer.createTransport({
        host: config.host,
        port: config.port,
        secure: config.secure,
        auth: config.user ? { user: config.user, pass: config.password } : undefined,
      });

  const info = await transport.sendMail({
    from: config.de || 'connecteur-sage@localhost',
    to: config.destinataires.join(', '),
    subject: sujet,
    text: texte,
    html,
    attachments: piecesJointes,
  });

  if (modeFichier) {
    await mkdir(path.join('sortie', 'emails'), { recursive: true });
    const fichier = path.join('sortie', 'emails', `${new Date().toISOString().replace(/[:.]/g, '-')}.eml`);
    await writeFile(fichier, info.message);
    return `e-mail écrit dans ${fichier} (mode test)`;
  }
  return `e-mail envoyé à ${config.destinataires.join(', ')}`;
}

// Petits outils de mise en forme partagés par les e-mails
export const echapper = (s) =>
  String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

export function gabaritHtml(titre, couleur, contenu) {
  return `<!doctype html><html><body style="font-family:Arial,sans-serif;font-size:14px;color:#222;max-width:680px">
<div style="border-left:6px solid ${couleur};padding:8px 16px;margin-bottom:16px"><h2 style="margin:0">${echapper(titre)}</h2></div>
${contenu}
<p style="color:#888;font-size:12px;margin-top:24px">Message automatique du connecteur Sage 100 → Shopify (SODICO).</p>
</body></html>`;
}
