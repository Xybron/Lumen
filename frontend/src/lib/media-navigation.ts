/** Only return to the local Media workspace; never trust a URL from a query. */
export function mediaReturnPath(query: { returnTo?: unknown; from?: unknown }): string | null {
  if (typeof query.returnTo === 'string') {
    try {
      const target = new URL(query.returnTo, 'https://lumen.invalid');
      if (target.origin === 'https://lumen.invalid' && target.pathname === '/media') {
        const asset = target.searchParams.get('asset');
        return asset ? `/media?${new URLSearchParams({ asset })}` : '/media';
      }
    } catch { /* Fall back to the known workspace for Media usage links. */ }
  }
  return query.from === 'media' ? '/media' : null;
}
