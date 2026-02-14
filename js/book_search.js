// book_search.js
// Lightweight module to search OpenLibrary and populate the entry form
import { tokenize as coreTokenize, baseTitle as coreBaseTitle, mergeOpenLibrary as coreMerge, enrichWithYear, enrichItunesWithYear, scoreDocument as coreScoreDocument, passesFilter as corePassesFilter, filterAndSort as coreFilterAndSort, deduplicateByDisplay as coreDedup, detectISBN, parseAuthorTitle } from './core/search_core.js';
import { resizeImageToBase64 } from './core/image_utils.js';
(function(){
  const form=document.getElementById('entryForm'); if(!form) return; const coverPreview=document.getElementById('coverPreview');
  const ui=document.getElementById('bookSearchUI'); const input=document.getElementById('bookSearchInput'); const resultsEl=document.getElementById('bookSearchResults');
  const editionNav=document.getElementById('editionNav'); const prevBtn=document.getElementById('prevEdition'); const nextBtn=document.getElementById('nextEdition'); const editionInfo=document.getElementById('editionInfo');
  const controls=document.getElementById('searchControls');
  // SVG book icon for cover placeholders (matches library card placeholder)
  const BOOK_SVG='<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
  function setCoverPlaceholder(ph,state){
    if(!ph) return;
    ph.style.display='flex';
    if(state==='loading') ph.innerHTML='<div class="placeholder-loading">Loading cover\u2026</div>';
    else if(state==='no-cover') ph.innerHTML='<div class="placeholder-icon">'+BOOK_SVG+'<span>No cover</span></div>';
    else ph.innerHTML='<div class="placeholder-icon">'+BOOK_SVG+'<span>Click or search to add cover</span></div>';
  }
  let sortMode='relevance'; let activeFilter='all';
  // precision state
  let lastQuery=''; let queryTokens=[]; let strictActive=false; // whether strict pass produced results
  // storage
  let olDocs=[]; let itunesItems=[]; // raw combined after merge
  let debounceTimer=null; let currentWork=null; let currentAudio=null; let editions=[]; let editionIndex=0;
  let searchCounter=0; // stale request detection for progressive loading
  function markDirty(){ try{ form.dispatchEvent(new Event('input',{bubbles:true})); }catch{} }
  function showUI(isEdit){ ui.style.display=isEdit?'none':'block'; if(isEdit) clearSearchState(); }
  function clearSearchState(){ currentWork=null; currentAudio=null; editions=[]; editionIndex=0; input.value=''; resultsEl.innerHTML=''; resultsEl.style.display='none'; editionNav.style.display='none'; if(controls) controls.style.display='none'; lastQuery=''; queryTokens=[]; strictActive=false; }
  function prepareQuery(q){ lastQuery=q.trim(); queryTokens=coreTokenize(lastQuery); }
  // Skeleton loading cards shown while APIs are in flight
  function showSkeletonCards(){
    resultsEl.innerHTML='<div class="search-status">Searching\u2026</div>'+
      '<div class="skeleton-result"><div class="skeleton-title"></div><div class="skeleton-author"></div></div>'.repeat(4);
  }
  // Progressive search: fires 3 APIs in parallel, renders results as each returns
  // Supports ISBN detection and "Title by Author" parsing for smarter queries
  async function searchTitle(q){ q=q.trim(); if(!q){ clearResults(); return; } prepareQuery(q);
    const mySearch=++searchCounter;
    const isStale=()=>mySearch!==searchCounter;
    // Show skeleton immediately
    resultsEl.style.display='block'; showSkeletonCards();
    const termFull=encodeURIComponent(q); const base=coreBaseTitle(q);
    // Use fields parameter for 10x smaller payloads (OpenLibrary optimization)
    const fields='key,title,author_key,author_name,cover_i,first_publish_year,publish_year,subtitle,physical_format';
    // Build URLs — may be overridden by ISBN or author parsing
    let titleUrl='https://openlibrary.org/search.json?title='+encodeURIComponent(base)+'&limit=50&fields='+fields;
    let broadUrl='https://openlibrary.org/search.json?q='+encodeURIComponent(q)+'&limit=50&fields='+fields;
    const itunesUrl='https://itunes.apple.com/search?media=audiobook&term='+termFull+'&limit=25';
    let skipBroad=false;
    // ISBN detection: if query looks like ISBN, use dedicated ISBN search
    const isbn=detectISBN(q);
    if(isbn.isISBN){
      titleUrl='https://openlibrary.org/search.json?isbn='+isbn.isbn+'&fields='+fields;
      skipBroad=true; // ISBN search is precise, no need for broad
    } else {
      // Author+title parsing: "Title by Author" → targeted search
      const parsed=parseAuthorTitle(q);
      if(parsed.author){
        titleUrl='https://openlibrary.org/search.json?title='+encodeURIComponent(parsed.title)+'&author='+encodeURIComponent(parsed.author)+'&limit=50&fields='+fields;
      }
    }
    // Progressive state tracked per-search
    let titleDocs=[]; let broadDocs=[]; let failTitle=false; let failBroad=false;
    let titleDone=false; let broadDone=skipBroad; let itunesDone=false;
    function mergeAndRender(){ if(isStale()) return; olDocs=coreMerge(titleDocs,broadDocs); if(controls) controls.style.display=(olDocs.length+itunesItems.length)?'flex':'none'; computeScoring(); renderCombined({failTitle,failBroad,partial:!titleDone||!broadDone||!itunesDone}); }
    // Fire title search (or ISBN search)
    fetch(titleUrl).then(r=>r.json().then(j=>({ok:r.ok,...j})).catch(()=>({ok:false,docs:[]}))).catch(()=>({ok:false,docs:[]}))
      .then(r=>{if(isStale())return;failTitle=!r.ok;titleDocs=r.docs||[];titleDone=true;mergeAndRender();});
    // Fire broad search (skipped for ISBN queries)
    if(!skipBroad){ fetch(broadUrl).then(r=>r.json().then(j=>({ok:r.ok,...j})).catch(()=>({ok:false,docs:[]}))).catch(()=>({ok:false,docs:[]}))
      .then(r=>{if(isStale())return;failBroad=!r.ok;broadDocs=r.docs||[];broadDone=true;mergeAndRender();}); }
    // Fire iTunes audiobook search
    fetch(itunesUrl).then(r=>r.json()).catch(()=>({results:[]}))
      .then(r=>{if(isStale())return;itunesItems=r.results||[];itunesDone=true;mergeAndRender();});
  }
  function clearResults(){ resultsEl.innerHTML=''; resultsEl.style.display='none'; if(controls) controls.style.display='none'; }
  function enrich(){ enrichWithYear(olDocs); enrichItunesWithYear(itunesItems); }
  // scoring & strict filtering
  function computeScoring(){ if(!queryTokens.length){ strictActive=false; return; } let anyStrict=false;
    olDocs.forEach(d=>{ const a=(d.author_name&&d.author_name[0])||''; const result = coreScoreDocument({ title: d.title, subtitle: d.subtitle, author: a, queryTokens, queryString: lastQuery, sortMode, year: d._yearComputed||0 }); d._score=result.score; d._coverage=result.coverage; d._strict=result.strict; if(d._strict) anyStrict=true; });
    itunesItems.forEach(i=>{ const title=i.collectionName||i.trackName||''; const author=i.artistName||''; const result = coreScoreDocument({ title, subtitle: '', author, queryTokens, queryString: lastQuery, sortMode, year: i._yearComputed||0 }); i._score=result.score; i._coverage=result.coverage; i._strict=result.strict; if(i._strict) anyStrict=true; });
    strictActive=anyStrict; }
  function highlight(text){ if(!queryTokens.length) return text; let html=text; queryTokens.forEach(t=>{ const re=new RegExp('('+t.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')+')','ig'); html=html.replace(re,'<mark>$1</mark>'); }); return html; }
  function sorted(){ enrich(); return coreFilterAndSort({ olDocs, itunesItems, activeFilter, sortMode, strictActive }); }
  function renderCombined(flags){ const failTitle=flags&&flags.failTitle; const failBroad=flags&&flags.failBroad; const partial=flags&&flags.partial; const {ol,it}=sorted();
    // Deduplicate OL results by display representation (title+author)
    const dedupOL=coreDedup(ol); const total=dedupOL.length+it.length;
    // Still loading and no results yet — keep skeleton visible
    if(partial && !total) return;
    const rows=[]; if(failTitle && failBroad){ rows.push('<div style="opacity:.55;font-size:.7rem;padding:2px 4px;color:#f87171">OpenLibrary unavailable (showing audio only / cached broader results if any).</div>'); }
    if(!total){ if(strictActive){ resultsEl.innerHTML='<div style="opacity:.5">No exact matches.</div>'; return; } resultsEl.innerHTML='<div style="opacity:.5">No results</div>'; return; }
    if(partial){ rows.push('<div class="search-status">'+total+' result'+(total!==1?'s':'')+', searching for more\u2026</div>'); }
    if(!strictActive && queryTokens.length){ rows.push('<div style="opacity:.55;font-size:.7rem;padding:2px 4px">No exact title match; showing broader results.</div>'); }
    if(failTitle && !failBroad){ rows.push('<div style="opacity:.45;font-size:.6rem;padding:2px 4px">Exact title search failed (fallback used).</div>'); }
    if(!failTitle && failBroad){ rows.push('<div style="opacity:.45;font-size:.6rem;padding:2px 4px">Broad search unavailable (exact only).</div>'); }
    dedupOL.forEach(d=>{ const title=(d.title||''); const sub=d.subtitle?(': '+d.subtitle):''; const safe=(title).replace(/</g,'&lt;'); const safeSub=sub.replace(/</g,'&lt;'); const combined=highlight(safe+safeSub); const author=(d.author_name&&d.author_name[0])?d.author_name[0]:''; const safeAuthor=highlight(author.replace(/</g,'&lt;')); const yr=d._yearComputed?` <span style="opacity:.45">${d._yearComputed}</span>`:''; const broadBadge = d._src==='broad' ? '<span class="src" style="background:#555">B</span>' : (d._src==='both' ? '<span class="src" style="background:#444">M</span>' : ''); const metaTitle=(d.title||'')+ (d.subtitle?(': '+d.subtitle):''); rows.push(`<div class="res" data-src="ol" data-work='${d.key}' data-cover='${d.cover_i||''}' data-json='${encodeURIComponent(JSON.stringify({title:metaTitle,author,cover_i:d.cover_i||'',work_key:d.key}))}'>${combined} <span style="opacity:.6">${safeAuthor}</span>${yr}<span class="src src-ol">OL</span>${broadBadge}</div>`); });
    it.forEach(item=>{ const title=(item.collectionName||item.trackName||''); const safe=highlight(title.replace(/</g,'&lt;')); const author=(item.artistName||'').replace(/</g,'&lt;'); const safeAuthor=highlight(author); const year=item._yearComputed||''; const payload={ title, author, year: year?String(year):'', artwork:item.artworkUrl100||'', narrator: author, rawNarrators: author }; rows.push(`<div class="res" data-src="it" data-json='${encodeURIComponent(JSON.stringify(payload))}'>${safe} <span style="opacity:.6">${safeAuthor}${year?(' • '+year):''}</span><span class="src src-it">IT</span></div>`); }); if(!rows.length){ resultsEl.innerHTML='<div style="opacity:.5">No results</div>'; return; } resultsEl.innerHTML=rows.slice(0,60).join(''); }
  function selectWork(meta){ currentAudio=null; currentWork=meta; editions=[]; editionIndex=0; editionNav.style.display='none';
    // Clear cover immediately when selecting new work
    if(window.bookishApp?.clearCoverPreview) window.bookishApp.clearCoverPreview();
    populateFromBasic(meta); fetchEditions(meta); }
  async function fetchEditions(meta){ try{ const url='https://openlibrary.org'+meta.work_key+'/editions.json?limit=50'; const r=await fetch(url); const j=await r.json(); editions=(j.entries||j.editions||[]).filter(e=>e); if(editions.length){ editionIndex=0; editionNav.style.display='flex'; applyEdition(); } }catch(e){} }
  async function selectItunes(payload){ currentWork=null; editions=[]; editionIndex=0; editionNav.style.display='none'; currentAudio=payload;
    // Clear previous cover
    if(window.bookishApp?.clearCoverPreview) window.bookishApp.clearCoverPreview();
    // Always set fields (not just when empty)
    form.title.value = payload.title || '';
    form.author.value = payload.author || '';
    if(payload.year) form.edition.value = payload.year;
    const fmtSel=Array.from(form.format.options).find(o=>o.value==='audiobook'); if(fmtSel) form.format.value='audiobook';
    markDirty();
    if(payload.artwork){ const hi=payload.artwork.replace(/100x100/,'600x600');
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'loading');
      coverPreview.style.display = 'none';
      try{ const resp=await fetch(hi); if(resp.ok){ const blob=await resp.blob();
        const { base64, mime, wasResized, dataUrl } = await resizeImageToBase64(blob);
        if(wasResized) console.info('[Bookish] iTunes cover resized for storage efficiency');
        coverPreview.src=dataUrl; coverPreview.style.display='block'; coverPreview.dataset.b64=base64; coverPreview.dataset.mime=mime; if(ph) ph.style.display='none'; if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded(); markDirty(); } else {
          setCoverPlaceholder(ph,'no-cover');
        } }catch(e){
        setCoverPlaceholder(ph,'no-cover');
      } } else {
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'no-cover');
    } }
  function populateFromBasic(meta){ if(!meta) return;
    // Always set fields (not just when empty)
    form.title.value = meta.title || '';
    if(meta.author) form.author.value = meta.author;
    markDirty();
    // Handle cover with loading state
    if(meta.cover_i) {
      loadCoverById(meta.cover_i);
    } else {
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'no-cover');
      coverPreview.style.display = 'none';
    } }

  function applyEdition(){ if(!editions.length) return; const ed=editions[editionIndex]; let changed=false; if(ed.title){ form.title.value=ed.title; changed=true; } if(ed.authors&&ed.authors.length){ const names=ed.authors.map(a=> a.name || a.author && a.author.key || '').filter(Boolean); if(names.length){ form.author.value=names.join(', '); changed=true; } } if(ed.publish_date){ form.edition.value=ed.publish_date; changed=true; } else if(ed.edition_name){ form.edition.value=ed.edition_name; changed=true; } if(ed.physical_format){ const fmt=(ed.physical_format||'').toLowerCase(); const opts=Array.from(form.format.options).map(o=>o.value); const match=opts.find(o=>fmt.includes(o)); if(match){ form.format.value=match; changed=true; } } if(changed) markDirty();
    if(ed.covers && ed.covers.length) {
      loadCoverById(ed.covers[0]);
    } else {
      // Edition has no cover - show placeholder
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'no-cover');
      coverPreview.src = '';
      coverPreview.style.display = 'none';
      delete coverPreview.dataset.b64;
      delete coverPreview.dataset.mime;
    }
    editionInfo.textContent=`Edition ${editionIndex+1} / ${editions.length}`; prevBtn.disabled=editionIndex===0; nextBtn.disabled=editionIndex===editions.length-1; }
  form && form.addEventListener('booksearch:applied', markDirty);
  async function loadCoverById(id){ const ph = document.getElementById('coverPlaceholder');
    if(!id) {
      setCoverPlaceholder(ph,'no-cover');
      coverPreview.style.display = 'none';
      return;
    }
    // Show loading state
    setCoverPlaceholder(ph,'loading');
    coverPreview.style.display = 'none';
    try {
      const url = `https://covers.openlibrary.org/b/id/${id}-L.jpg`;
      const resp = await fetch(url);
      if(!resp.ok) {
        setCoverPlaceholder(ph,'no-cover');
        return;
      }
      const blob = await resp.blob();
      // Resize before storing (saves ~90% on Arweave costs)
      const { base64, mime, wasResized, dataUrl } = await resizeImageToBase64(blob);
      if(wasResized) console.info('[Bookish] Cover resized for storage efficiency');
      coverPreview.src = dataUrl;
      coverPreview.style.display = 'block';
      coverPreview.dataset.b64 = base64;
      coverPreview.dataset.mime = mime;
      if(ph) ph.style.display = 'none';
      if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded();
      markDirty();
    } catch(e) {
      setCoverPlaceholder(ph,'no-cover');
    } }
  // blobToBase64 removed — now imported from core/image_utils.js via resizeImageToBase64
  input.addEventListener('input',()=>{ if(debounceTimer) clearTimeout(debounceTimer); debounceTimer=setTimeout(()=>searchTitle(input.value),350); });
  resultsEl.addEventListener('click',e=>{ const div=e.target.closest('div.res'); if(!div) return; resultsEl.style.display='none'; const src=div.dataset.src; try{ const meta=JSON.parse(decodeURIComponent(div.dataset.json)); if(src==='ol') selectWork(meta); else if(src==='it') selectItunes(meta); }catch(err){} });
  prevBtn.addEventListener('click',()=>{ if(editionIndex>0){ editionIndex--; applyEdition(); }}); nextBtn.addEventListener('click',()=>{ if(editionIndex<editions.length-1){ editionIndex++; applyEdition(); }});
  if(controls){ controls.addEventListener('click',e=>{ const f=e.target.closest('.filter-btn'); const s=e.target.closest('.sort-btn'); if(f){ const val=f.dataset.filter; if(val && val!==activeFilter){ activeFilter=val; controls.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active', b.dataset.filter===activeFilter)); renderCombined(); } }
    if(s){ const mode=s.dataset.mode; if(mode && mode!==sortMode){ sortMode=mode; controls.querySelectorAll('.sort-btn').forEach(b=>b.classList.toggle('active', b.dataset.mode===sortMode)); renderCombined(); } }
  }); }
  window.bookSearch={ handleModalOpen(isEdit){ showUI(isEdit); } };
})();
