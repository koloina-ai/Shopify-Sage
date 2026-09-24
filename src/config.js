// Configuration lue dans les variables d'environnement (.env ou ../env.local).

export function configShopify() {
  return {
    // Noms alternatifs : ceux du env.local partagé avec Talend / Postman
    store: process.env.SHOPIFY_STORE || process.env.SHOPIFY_STORE_URL,
    apiVersion: process.env.SHOPIFY_API_VERSION || '2026-07',
    accessToken: process.env.SHOPIFY_ACCESS_TOKEN || process.env.SHOPIFY_STORE_API_TOKEN,
    clientId: process.env.SHOPIFY_CLIENT_ID,
    clientSecret: process.env.SHOPIFY_CLIENT_SECRET,
  };
}

// Par défaut : SQL Server local, base SODICO_TEST, authentification Windows.
export function chaineConnexionSage() {
  return (
    process.env.SAGE_SQL_CONNECTION ||
    'Driver={ODBC Driver 18 for SQL Server};Server=localhost;Database=SODICO_TEST;Trusted_Connection=yes;TrustServerCertificate=yes;'
  );
}
