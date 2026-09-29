// Page de suivi du connecteur, dans le navigateur : npm run interface
// Par défaut accessible uniquement depuis ce poste (http://localhost:3000).
// INTERFACE_HOTE=0.0.0.0 pour l'ouvrir au réseau local — mettre alors un INTERFACE_MOT_DE_PASSE.

import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { parseEnv } from 'node:util';
import { createHash, timingSafeEqual } from 'node:crypto';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { configShopify } from './config.js';
import { creerClient } from './shopify.js';
import { articlesBloques, connecterSage, famillesCatalogue } from './sage.js';
import { emplacementParDefaut, lireFamillesShopify } from './familles.js';
import { diagnostiquer } from './alertes.js';
import { csvArticles, lireChangements, lirePassages, synchroEnCours } from './suivi.js';
import { modeCommandes } from './commandes-sage/index.js';

const RACINE = fileURLToPath(new URL('..', import.meta.url));
process.chdir(RACINE);

const HOTE = process.env.INTERFACE_HOTE || '127.0.0.1';
const PORT = Number(process.env.INTERFACE_PORT) || 3000;
const MOT_DE_PASSE = process.env.INTERFACE_MOT_DE_PASSE || '';
const INTERVALLE_ATTENDU_MIN = Number(process.env.INTERVALLE_SYNCHRO_MIN) || 15;
const HEURE = 3600 * 1000;

// ---------- Données (avec petit cache pour ne pas interroger Sage/Shopify à chaque rafraîchissement) ----------

function enCache(dureeMs, calcul) {
  let valeur;
  let expire = 0;
  let enCours = null;
  return async () => {
    if (Date.now() < expire) return valeur;
    enCours ??= calcul()
      .then((v) => {
        valeur = v;
        expire = Date.now() + dureeMs;
        return v;
      })
      .finally(() => {
        enCours = null;
      });
    return enCours;
  };
}

const lireJson = async (fichier) => JSON.parse(await readFile(fichier, 'utf8').catch(() => '{}'));

const produitsEnVente = enCache(60_000, async () => {
  try {
    const client = creerClient(configShopify());
    const geres = (await lireFamillesShopify(client, await emplacementParDefaut(client))).filter((f) => f.proprietaire);
    return {
      actifs: geres.filter((p) => p.statut === 'ACTIVE').length,
      variantes: geres.filter((p) => p.statut === 'ACTIVE').reduce((n, f) => n + f.variantes.length, 0),
      brouillons: geres.filter((p) => p.statut !== 'ACTIVE').length,
      ignores: geres.filter((p) => p.ignore).length,
    };
  } catch (err) {
    return { erreur: err.message };
  }
});

const bloques = enCache(60_000, async () => {
  const familles = famillesCatalogue();
  let pool;
  try {
    pool = await connecterSage();
    const articles = await articlesBloques(pool, familles);
    const parRaison = Object.values(Object.groupBy(articles, (a) => a.raison))
      .map((liste) => ({ raison: liste[0].raison, aCorriger: liste[0].aCorriger, nombre: liste.length }))
      .sort((a, b) => b.nombre - a.nombre);
    return { familles, total: articles.length, parRaison, articles };
  } catch (err) {
    return { erreur: `Sage inaccessible : ${err.message}`, familles, total: 0, parRaison: [], articles: [] };
  } finally {
    await pool?.close();
  }
});

async function etat() {
  const [passages, enCours, alertes, etatProduits, vente] = await Promise.all([
    lirePassages(Date.now() - 24 * HEURE),
    synchroEnCours(),
    lireJson('etat/alertes.json'),
    lireJson('etat/catalogue.json'),
    produitsEnVente(),
  ]);
  const dernier = passages.at(-1) ?? null;
  const minutesDepuis = dernier ? Math.round((Date.now() - dernier.date.getTime()) / 60000) : null;
  return {
    maintenant: new Date(),
    enCours,
    dernier: dernier && {
      date: dernier.date,
      ok: dernier.ok,
      resultat: dernier.resultat,
      diagnostics: dernier.ok ? [] : diagnostiquer(dernier.erreurs).map(({ probleme, action }) => ({ probleme, action })),
    },
    // Plus de 2 intervalles sans synchro : la tâche planifiée est sans doute arrêtée
    enRetard: !enCours && (minutesDepuis === null || minutesDepuis > 2 * INTERVALLE_ATTENDU_MIN),
    minutesDepuis,
    panneDepuis: alertes.enPanne ? alertes.depuis : null,
    passages24h: { total: passages.length, echecs: passages.filter((p) => !p.ok).length },
    catalogue: { dernier: etatProduits.dernier ?? null, familles: famillesCatalogue() },
    commandes: { mode: modeCommandes(), simulation: process.env.OM_SIMULATION === 'oui' },
    vente,
  };
}

async function historique(heures) {
  const passages = await lirePassages(Date.now() - heures * HEURE);
  return passages
    .slice(-50)
    .reverse()
    .map((p) => ({ debut: p.debut, date: p.date, ok: p.ok, resultat: p.resultat, lignes: p.lignes }));
}

// ---------- Actions ----------

// Le bouton lance « npm run synchro-catalogue » : catalogue (familles, variantes, prix, code-barre), stocks, commandes.
// Journal, verrou et alertes identiques à la tâche planifiée. Arguments repris de package.json (node lancé
// directement : npm.cmd exigerait un shell sous Windows).
const SCRIPT_SYNCHRO = 'synchro-catalogue';
const FICHIERS_ENV = ['.env', '../env.local'];
// Variables venues des fichiers .env au démarrage de la page : retirées de l'environnement transmis, pour que la synchro
// relise les fichiers à chaque clic (un .env modifié s'applique sans redémarrer la page, une ligne supprimée aussi).
const VARIABLES_FICHIERS = new Map(
  FICHIERS_ENV.flatMap((f) => {
    try {
      return Object.entries(parseEnv(readFileSync(path.join(RACINE, f), 'utf8')));
    } catch {
      return [];
    }
  }),
);

async function lancerSynchro() {
  if (await synchroEnCours()) return { code: 409, corps: { message: 'Une synchronisation est déjà en cours.' } };
  const script = JSON.parse(await readFile(path.join(RACINE, 'package.json'), 'utf8')).scripts?.[SCRIPT_SYNCHRO];
  if (!script?.startsWith('node ')) return { code: 500, corps: { message: `Script « ${SCRIPT_SYNCHRO} » introuvable dans package.json.` } };
  const env = Object.fromEntries(Object.entries(process.env).filter(([k, v]) => VARIABLES_FICHIERS.get(k) !== v));
  const enfant = spawn(process.execPath, script.split(/\s+/).slice(1), { cwd: RACINE, env, stdio: 'ignore', windowsHide: true });
  enfant.unref();
  return { code: 202, corps: { message: 'Synchronisation lancée.' } };
}

// ---------- Sécurité HTTP ----------

const LOCAL = ['127.0.0.1', 'localhost', '::1'];
const EXPOSEE = !LOCAL.includes(HOTE);
if (EXPOSEE && !MOT_DE_PASSE && process.env.INTERFACE_SANS_MOT_DE_PASSE !== 'oui') {
  console.error(
    'Refus de démarrer : la page serait accessible depuis le réseau sans mot de passe.\n' +
      'Définir INTERFACE_MOT_DE_PASSE dans .env (ou INTERFACE_SANS_MOT_DE_PASSE=oui pour l\'accepter en connaissance de cause).',
  );
  process.exit(1);
}

// Noms sous lesquels la page peut être appelée. Refuser les autres bloque le « DNS rebinding »
// (un site piégé qui se fait passer pour ce serveur afin de lire les données ou de lancer une synchro).
// Autorisés automatiquement : localhost, le nom du serveur (court ou complet) et ses adresses IP.
const NOM_MACHINE = os.hostname().toLowerCase();
const NOMS_AUTORISES = new Set([
  ...LOCAL,
  NOM_MACHINE,
  ...Object.values(os.networkInterfaces()).flat().map((i) => i.address.toLowerCase()),
  ...(process.env.INTERFACE_NOMS || '').split(',').map((n) => n.trim().toLowerCase()).filter(Boolean),
]);
function hoteAutorise(req) {
  const hote = (req.headers.host || '').toLowerCase().replace(/:\d+$/, '').replace(/^\[|\]$/g, '');
  return NOMS_AUTORISES.has(hote) || hote.startsWith(`${NOM_MACHINE}.`);
}

// Mots de passe erronés : après ESSAIS_MAX échecs, le poste est bloqué BLOCAGE_MS (puis peut réessayer).
const ESSAIS_MAX = 5;
const BLOCAGE_MS = 5 * 60 * 1000;
const echecs = new Map(); // adresse IP -> { nombre, bloqueJusqua }

function autorise(req) {
  if (!MOT_DE_PASSE) return true;
  const [type, valeur] = (req.headers.authorization || '').split(' ');
  if (type !== 'Basic' || !valeur) return false;
  const saisi = Buffer.from(Buffer.from(valeur, 'base64').toString().split(':').slice(1).join(':'));
  const attendu = Buffer.from(MOT_DE_PASSE);
  return saisi.length === attendu.length && timingSafeEqual(saisi, attendu);
}

// Page servie avec une politique de sécurité stricte : seul le script de la page (identifié par son empreinte)
// peut s'exécuter, rien ne peut être chargé d'ailleurs, et la page ne peut pas être affichée dans un autre site.
const PAGE = await readFile(path.join('src', 'interface', 'page.html'));
// Le navigateur calcule l'empreinte après avoir normalisé les fins de ligne (CRLF -> LF) : faire de même,
// sinon un fichier enregistré avec des fins de ligne Windows bloquerait le script de la page.
const SCRIPT_PAGE = PAGE.toString('utf8').match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\r\n?/g, '\n');
const EMPREINTE_SCRIPT = createHash('sha256').update(SCRIPT_PAGE).digest('base64');
const ENTETES_SECURITE = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Content-Security-Policy':
    `default-src 'none'; script-src 'sha256-${EMPREINTE_SCRIPT}'; style-src 'unsafe-inline'; connect-src 'self'; ` +
    `img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'`,
};

function repondre(res, code, corps, type = 'application/json; charset=utf-8', entetes = {}) {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store', ...ENTETES_SECURITE, ...entetes });
  res.end(typeof corps === 'string' || Buffer.isBuffer(corps) ? corps : JSON.stringify(corps));
}

// ---------- Serveur HTTP ----------

const serveur = createServer(async (req, res) => {
  try {
    if (!hoteAutorise(req)) return repondre(res, 403, 'Adresse non autorisée', 'text/plain; charset=utf-8');

    if (MOT_DE_PASSE) {
      const ip = req.socket.remoteAddress;
      const suivi = echecs.get(ip);
      if (suivi?.bloqueJusqua > Date.now()) {
        const minutes = Math.ceil((suivi.bloqueJusqua - Date.now()) / 60000);
        return repondre(res, 429, `Trop d'essais de mot de passe : réessayer dans ${minutes} min.`, 'text/plain; charset=utf-8');
      }
      if (!autorise(req)) {
        // Premier affichage (pas encore de mot de passe saisi) : ce n'est pas un échec
        if (req.headers.authorization) {
          const nombre = (suivi?.nombre ?? 0) + 1;
          echecs.set(ip, nombre >= ESSAIS_MAX ? { nombre: 0, bloqueJusqua: Date.now() + BLOCAGE_MS } : { nombre });
          if (echecs.size > 1000) echecs.clear(); // borne mémoire
        }
        return repondre(res, 401, 'Mot de passe requis', 'text/plain; charset=utf-8', {
          'WWW-Authenticate': 'Basic realm="Connecteur Sage-Shopify", charset="UTF-8"',
        });
      }
      echecs.delete(ip);
    }

    const url = new URL(req.url, 'http://localhost');

    if (req.method === 'GET' && url.pathname === '/') return repondre(res, 200, PAGE, 'text/html; charset=utf-8');
    if (req.method === 'GET' && url.pathname === '/api/etat') return repondre(res, 200, await etat());
    if (req.method === 'GET' && url.pathname === '/api/historique') {
      return repondre(res, 200, await historique(Math.min(Number(url.searchParams.get('heures')) || 48, 24 * 30)));
    }
    if (req.method === 'GET' && url.pathname === '/api/changements') {
      return repondre(res, 200, await lireChangements(Date.now() - Math.min(Number(url.searchParams.get('heures')) || 24, 24 * 30) * HEURE));
    }
    if (req.method === 'GET' && url.pathname === '/api/bloques') {
      const { articles, ...resume } = await bloques();
      return repondre(res, 200, { ...resume, articles });
    }
    if (req.method === 'GET' && url.pathname === '/api/bloques.csv') {
      const nom = `articles-a-corriger-${new Date().toISOString().slice(0, 10)}.csv`;
      return repondre(res, 200, csvArticles((await bloques()).articles), 'text/csv; charset=utf-8', {
        'Content-Disposition': `attachment; filename="${nom}"`,
      });
    }
    if (req.method === 'POST' && url.pathname === '/api/synchro') {
      // En-tête obligatoire : un autre site ne peut pas déclencher l'action à la place de l'utilisateur.
      if (req.headers['x-connecteur'] !== '1') return repondre(res, 403, { message: 'Requête refusée' });
      const { code, corps } = await lancerSynchro();
      return repondre(res, code, corps);
    }
    repondre(res, 404, { message: 'Introuvable' });
  } catch (err) {
    console.error(`Erreur ${req.method} ${req.url} : ${err.message}`);
    repondre(res, 500, { message: 'Erreur interne du connecteur (voir la console du serveur)' });
  }
});

serveur.listen(PORT, HOTE, () => {
  const adresse = EXPOSEE ? `http://${NOM_MACHINE}:${PORT}` : `http://localhost:${PORT}`;
  console.log(`Page de suivi du connecteur : ${adresse}`);
  if (EXPOSEE && !MOT_DE_PASSE) console.warn('⚠ Page ouverte au réseau SANS mot de passe (INTERFACE_SANS_MOT_DE_PASSE=oui)');
});
