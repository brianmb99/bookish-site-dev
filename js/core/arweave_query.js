// arweave_query.js - Pure Arweave query primitives and book entry search
// No DOM, no IndexedDB, no window globals — safe to bundle into any context
//
// Uploads go through ArDrive Turbo, which caches data on turbo-gateway.com
// and seeds it to Arweave L1. Both gateways are used for reads.

export const ARWEAVE_GRAPHQL = 'https://arweave.net/graphql';
export const ARWEAVE_GATEWAY = 'https://arweave.net';
export const TURBO_GATEWAY = 'https://turbo-gateway.com';

/**
 * Resilient Arweave GraphQL query.  Returns structured results — never
 * throws for HTTP errors, non-200 status, or JSON parse failures.
 *
 * Every call site that hits arweave.net/graphql should use this instead
 * of raw fetch so error handling is consistent across the codebase.
 *
 * @param {string} query  - GraphQL query string
 * @param {Object} [variables] - GraphQL variables
 * @returns {Promise<{data: Object|null, error: string|null}>}
 */
export async function queryGraphQL(query, variables) {
  try {
    const response = await fetch(ARWEAVE_GRAPHQL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(variables ? { query, variables } : { query })
    });

    if (!response.ok) {
      console.warn('[Bookish] Arweave GraphQL HTTP', response.status);
      return { data: null, error: `http_${response.status}` };
    }

    const json = await response.json();

    if (json.errors?.length) {
      console.warn('[Bookish] Arweave GraphQL error:', json.errors[0].message);
      return { data: null, error: json.errors[0].message };
    }

    return { data: json.data, error: null };
  } catch (err) {
    console.warn('[Bookish] Arweave GraphQL failed:', err.message);
    return { data: null, error: err.message };
  }
}

/**
 * Search for book entries on Arweave (single page).
 *
 * Returns edges + pageInfo + an error field.  When the GraphQL endpoint
 * is unreachable the function returns empty results with a non-null error
 * string — it never throws.  Callers decide how to degrade.
 *
 * @param {string} address - EVM wallet address (used for Pub-Addr tag)
 * @param {Object} [options]
 * @param {string} [options.owner] - Arweave owner address for legacy t2 query
 * @param {number} [options.limit=100] - Page size
 * @param {string} [options.cursor] - Pagination cursor from previous page
 * @param {string} [options.appName='bookish'] - App-Name tag value
 * @returns {Promise<{edges: Array, pageInfo: {hasNextPage: boolean}, error: string|null}>}
 */
export async function searchBookEntries(address, { owner = null, limit = 100, cursor = null, appName = 'bookish' } = {}) {
  const pub = address?.toLowerCase();
  const tags = [
    { name: 'App-Name', values: [appName] },
    { name: 'Schema-Name', values: ['reading'] },
    { name: 'Visibility', values: ['private'] },
    ...(pub ? [{ name: 'Pub-Addr', values: [pub] }] : [])
  ];

  const q = owner
    ? `query($after:String,$first:Int,$tags:[TagFilter!],$owners:[String!]){
      t1:transactions(after:$after,first:$first,sort:HEIGHT_DESC,tags:$tags){pageInfo{hasNextPage}edges{cursor node{id tags{name value}block{timestamp height}}}}
      t2:transactions(after:$after,first:$first,sort:HEIGHT_DESC,owners:$owners,tags:$tags){pageInfo{hasNextPage}edges{cursor node{id tags{name value}block{timestamp height}}}}
    }`
    : `query($after:String,$first:Int,$tags:[TagFilter!]){
      t1:transactions(after:$after,first:$first,sort:HEIGHT_DESC,tags:$tags){pageInfo{hasNextPage}edges{cursor node{id tags{name value}block{timestamp height}}}}
    }`;
  const variables = owner
    ? { after: cursor ?? null, first: limit, tags, owners: [owner] }
    : { after: cursor ?? null, first: limit, tags };

  console.log('[Bookish] searchBookEntries address:', pub, 'tags:', tags.length);

  const { data, error } = await queryGraphQL(q, variables);

  const seen = new Set();
  const merged = [];
  let hasNext = false;

  if (data) {
    const edges1 = data.t1?.edges || [];
    const edges2 = data.t2?.edges || [];
    for (const e of [...edges1, ...edges2]) {
      if (!seen.has(e.node.id)) { seen.add(e.node.id); merged.push(e); }
    }
    hasNext = !!(data.t1?.pageInfo?.hasNextPage || data.t2?.pageInfo?.hasNextPage);
  }

  console.log(`[Bookish] Book query: ${merged.length} entries`);

  return { edges: merged, pageInfo: { hasNextPage: hasNext }, error };
}

// --- Tombstone/superseded filtering ---

function isTomb(e) { return e.node.tags?.some(t => t.name === 'Op' && t.value === 'tombstone'); }
function refOf(e) { return e.node.tags?.find(t => t.name === 'Ref')?.value; }

/**
 * Compute live entries from raw GraphQL edges, filtering tombstones and superseded versions.
 * Pure function — no side effects.
 *
 * @param {Array} allEdges - Raw GraphQL edges (from searchBookEntries)
 * @returns {{liveEdges: Array, tombstones: Array<{txid: string, ref: string}>}}
 */
export function computeLiveSets(allEdges) {
  const tombstones = allEdges.filter(isTomb).map(e => ({ txid: e.node.id, ref: refOf(e) }));

  const edgesWithPrev = allEdges.filter(e => e.node.tags?.some(t => t.name === 'Prev'));
  const superseded = new Set(edgesWithPrev.map(e => e.node.tags.find(t => t.name === 'Prev')?.value).filter(Boolean));

  const tombRefs = new Set(tombstones.map(t => t.ref).filter(Boolean));
  const liveEdges = allEdges.filter(e => {
    if (isTomb(e)) return false;
    if (tombRefs.has(e.node.id)) return false;
    if (superseded.has(e.node.id)) return false;
    return true;
  });

  return { liveEdges, tombstones };
}

/**
 * Download raw transaction bytes.
 * Tries Arweave L1 first, then Turbo's cache (recently uploaded data
 * may not be on L1 yet while the bundle is being posted).
 *
 * @param {string} txid - Transaction ID
 * @returns {Promise<Uint8Array>} - Raw encrypted bytes
 */
export async function fetchTxData(txid) {
  try {
    const rA = await fetch(`${ARWEAVE_GATEWAY}/${txid}`);
    if (rA.ok) return new Uint8Array(await rA.arrayBuffer());
  } catch { /* fall through */ }
  try {
    const rT = await fetch(`${TURBO_GATEWAY}/${txid}`);
    if (rT.ok) return new Uint8Array(await rT.arrayBuffer());
  } catch { /* fall through */ }
  throw new Error('Failed to fetch ' + txid);
}
