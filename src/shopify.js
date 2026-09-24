// Client minimal pour l'Admin GraphQL API de Shopify.

const MAX_TENTATIVES = 5;

export function creerClient({ store, apiVersion, accessToken, clientId, clientSecret }) {
  if (!store) throw new Error('SHOPIFY_STORE manquant dans .env');
  if (!accessToken && !(clientId && clientSecret)) {
    throw new Error(
      'Authentification manquante : renseigner SHOPIFY_ACCESS_TOKEN, ou SHOPIFY_CLIENT_ID + SHOPIFY_CLIENT_SECRET',
    );
  }

  const domaine = store.replace(/^https?:\/\//, '').replace(/\/$/, '');
  const endpoint = `https://${domaine}/admin/api/${apiVersion}/graphql.json`;
  let tokenCache = accessToken ? { valeur: accessToken, expireA: Infinity } : null;

  // Client credentials grant : token de 24 h, renouvelé 5 min avant expiration.
  async function obtenirToken() {
    if (tokenCache && Date.now() < tokenCache.expireA) return tokenCache.valeur;

    const res = await fetch(`https://${domaine}/admin/oauth/access_token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
    const corps = await res.json().catch(() => ({}));
    if (!res.ok || !corps.access_token) {
      throw new Error(`Échec d'obtention du token (${res.status}) : ${JSON.stringify(corps)}`);
    }
    tokenCache = {
      valeur: corps.access_token,
      expireA: Date.now() + (corps.expires_in - 300) * 1000,
    };
    return tokenCache.valeur;
  }

  async function requete(query, variables = {}) {
    for (let tentative = 1; ; tentative++) {
      const res = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': await obtenirToken(),
        },
        body: JSON.stringify({ query, variables }),
      });

      if (res.status === 429 || res.status >= 500) {
        if (tentative >= MAX_TENTATIVES) throw new Error(`Shopify HTTP ${res.status} après ${tentative} tentatives`);
        await pause(1000 * 2 ** tentative);
        continue;
      }
      if (!res.ok) {
        throw new Error(`Shopify HTTP ${res.status} : ${await res.text()}`);
      }

      const corps = await res.json();
      const erreurs = corps.errors ?? [];

      if (erreurs.some((e) => e.extensions?.code === 'THROTTLED') && tentative < MAX_TENTATIVES) {
        await pause(attenteAvantRecharge(corps.extensions?.cost));
        continue;
      }
      // Sans données exploitables, on échoue ; sinon on remonte les erreurs partielles
      // (ex. ACCESS_DENIED sur les données client protégées).
      if (!corps.data) {
        throw new Error(`Erreur GraphQL : ${erreurs.map((e) => e.message).join(' | ')}`);
      }
      return { data: corps.data, erreurs };
    }
  }

  return { requete };
}

function attenteAvantRecharge(cost) {
  const statut = cost?.throttleStatus;
  if (!statut) return 2000;
  const manque = Math.max(0, (cost.requestedQueryCost ?? 0) - statut.currentlyAvailable);
  return Math.ceil((manque / statut.restoreRate) * 1000) + 250;
}

const pause = (ms) => new Promise((r) => setTimeout(r, ms));
