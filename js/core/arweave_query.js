// arweave_query.js - Pure Arweave/Irys book entry query and filtering
// No DOM, no IndexedDB, no window globals — safe to bundle into any context

export const ARWEAVE_GRAPHQL = 'https://arweave.net/graphql';
export const IRYS_NODE1_GRAPHQL = 'https://node1.irys.xyz/graphql';
export const IRYS_NODE2_GRAPHQL = 'https://node2.irys.xyz/graphql';
export const IRYS_GATEWAY = 'https://gateway.irys.xyz';
export const ARWEAVE_GATEWAY = 'https://arweave.net';

/**
 * Search for book entries on Arweave + Irys (single page).
 * Queries arweave.net (with optional owner-based fallback) and both Irys nodes
 * in parallel, then merges and deduplicates results.
 *
 * @param {string} address - EVM wallet address (used for Pub-Addr tag)
 * @param {Object} [options]
 * @param {string} [options.owner] - Arweave owner address for legacy t2 query
 * @param {number} [options.limit=100] - Page size
 * @param {string} [options.cursor] - Pagination cursor from previous page
 * @param {string} [options.appName='bookish'] - App-Name tag value
 * @returns {Promise<{edges: Array, pageInfo: {hasNextPage: boolean}}>}
 */
export async function searchBookEntries(address, { owner = null, limit = 100, cursor = null, appName = 'bookish' } = {}) {
  const pub = address?.toLowerCase();
  const tags = [
    { name: 'App-Name', values: [appName] },
    { name: 'Schema-Name', values: ['reading'] },
    { name: 'Visibility', values: ['private'] },
    ...(pub ? [{ name: 'Pub-Addr', values: [pub] }] : [])
  ];

  // Arweave query — supports sort, owners, block info
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

  const arweaveBody = JSON.stringify({ query: q, variables });
  console.log('[Bookish] searchBookEntries address:', pub, 'owner:', owner, 'tags:', tags.length);
  console.log('[Bookish] Arweave request body:', arweaveBody.slice(0, 600));
  const arweaveT0 = Date.now();

  const arweavePromise = fetch(ARWEAVE_GRAPHQL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: arweaveBody
  })
    .then(r => {
      console.log('[Bookish] Arweave HTTP', r.status, 'in', Date.now() - arweaveT0, 'ms');
      return r.text();
    })
    .then(text => {
      console.log('[Bookish] Arweave raw response:', text.slice(0, 400));
      try { return JSON.parse(text); } catch (e) { console.warn('[Bookish] Arweave JSON parse failed'); return null; }
    })
    .catch(err => { console.warn('[Bookish] Arweave book search failed:', err.message); return null; });

  // Irys supplemental — first page only, uses inline tags (Irys syntax differs from arweave.net)
  let irysNode1Promise = Promise.resolve(null);
  let irysNode2Promise = Promise.resolve(null);
  if (!cursor && pub) {
    const irysTagsStr = tags.map(t => `{name:"${t.name}",values:${JSON.stringify(t.values)}}`).join(',');
    const irysQ = `{transactions(tags:[${irysTagsStr}],first:${limit}){edges{node{id tags{name value}}}}}`;
    const irysBody = JSON.stringify({ query: irysQ });
    console.log('[Bookish] Irys request body:', irysBody.slice(0, 400));
    const irysT0 = Date.now();
    irysNode1Promise = fetch(IRYS_NODE1_GRAPHQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: irysBody })
      .then(r => { console.log('[Bookish] Irys node1 HTTP', r.status, 'in', Date.now() - irysT0, 'ms'); return r.text(); })
      .then(text => { console.log('[Bookish] Irys node1 raw:', text.slice(0, 300)); try { return JSON.parse(text); } catch { return null; } })
      .catch(err => { console.warn('[Bookish] Irys node1 query failed:', err.message); return null; });
    irysNode2Promise = fetch(IRYS_NODE2_GRAPHQL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: irysBody })
      .then(r => { console.log('[Bookish] Irys node2 HTTP', r.status, 'in', Date.now() - irysT0, 'ms'); return r.text(); })
      .then(text => { console.log('[Bookish] Irys node2 raw:', text.slice(0, 300)); try { return JSON.parse(text); } catch { return null; } })
      .catch(err => { console.warn('[Bookish] Irys node2 query failed:', err.message); return null; });
  }

  const [arJson, irJson1, irJson2] = await Promise.all([arweavePromise, irysNode1Promise, irysNode2Promise]);

  let arweaveHasNext = false;
  const seen = new Set();
  const merged = [];

  if (arJson?.data) {
    const edges1 = arJson.data.t1?.edges || [];
    const edges2 = arJson.data.t2?.edges || [];
    for (const e of [...edges1, ...edges2]) {
      if (!seen.has(e.node.id)) { seen.add(e.node.id); merged.push(e); }
    }
    arweaveHasNext = !!(arJson.data.t1?.pageInfo?.hasNextPage || arJson.data.t2?.pageInfo?.hasNextPage);
  }

  let irysOnlyCount = 0;
  const node1Count = irJson1?.data?.transactions?.edges?.length || 0;
  const node2Count = irJson2?.data?.transactions?.edges?.length || 0;

  for (const irJson of [irJson1, irJson2]) {
    if (irJson?.data?.transactions?.edges) {
      for (const e of irJson.data.transactions.edges) {
        if (!seen.has(e.node.id)) {
          seen.add(e.node.id);
          merged.push({ ...e, node: { ...e.node, block: null } });
          irysOnlyCount++;
        }
      }
    }
  }

  const arweaveCount = merged.length - irysOnlyCount;
  console.log(`[Bookish] Merged edges: ${merged.length} total (Arweave:${arweaveCount}, Irys-only:${irysOnlyCount}, node1:${node1Count}, node2:${node2Count})`);

  const irysEdgesWithPrev = [];
  for (const e of merged) {
    const prevTag = e.node.tags?.find(t => t.name === 'Prev');
    if (prevTag && !e.node.block) {
      irysEdgesWithPrev.push({ txid: e.node.id.slice(0, 8), prev: prevTag.value.slice(0, 8) });
    }
  }
  if (irysEdgesWithPrev.length > 0) {
    console.log('[Bookish] Irys entries with Prev tags:', irysEdgesWithPrev);
  }

  if (merged.length === 0 && !arJson?.data && !irJson1?.data && !irJson2?.data) {
    throw new Error('graphql');
  }

  return { edges: merged, pageInfo: { hasNextPage: arweaveHasNext } };
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

  if (edgesWithPrev.length > 0) {
    console.log('[Bookish] Version chains found:', edgesWithPrev.map(e => ({
      txid: e.node.id.slice(0, 8),
      prev: e.node.tags.find(t => t.name === 'Prev')?.value?.slice(0, 8)
    })));
    console.log('[Bookish] Superseded txids:', [...superseded].map(s => s.slice(0, 8)));
  }

  const tombRefs = new Set(tombstones.map(t => t.ref).filter(Boolean));
  const liveEdges = allEdges.filter(e => {
    if (isTomb(e)) return false;
    if (tombRefs.has(e.node.id)) return false;
    if (superseded.has(e.node.id)) return false;
    return true;
  });

  if (liveEdges.length > 5) {
    console.warn('[Bookish] More live entries than expected:', liveEdges.map(e => e.node.id.slice(0, 8)));
  }

  return { liveEdges, tombstones };
}

/**
 * Download raw transaction bytes from Irys or Arweave gateways.
 * Tries Irys first (faster for recently uploaded data), falls back to Arweave.
 *
 * @param {string} txid - Arweave/Irys transaction ID
 * @returns {Promise<Uint8Array>} - Raw encrypted bytes
 */
export async function fetchTxData(txid) {
  try {
    const rI = await fetch(`${IRYS_GATEWAY}/${txid}`);
    if (rI.ok) return new Uint8Array(await rI.arrayBuffer());
  } catch { /* fall through */ }
  try {
    const rA = await fetch(`${ARWEAVE_GATEWAY}/${txid}`);
    if (rA.ok) return new Uint8Array(await rA.arrayBuffer());
  } catch { /* fall through */ }
  throw new Error('Failed to fetch ' + txid);
}
