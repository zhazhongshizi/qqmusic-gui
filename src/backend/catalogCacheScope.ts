// Cached authenticated catalogue reads must not outlive an account change.
let account = "";
let revision = 0;
export const catalogCacheRevision = () => revision;
export function updateCatalogAccount(value: string) {
  if (account !== value) { account = value; revision++; }
}
export function invalidateCatalogAccount() { revision++; account = ""; }
