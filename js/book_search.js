// book_search.js
// Lightweight module to search OpenLibrary and populate the entry form
import { tokenize as coreTokenize, baseTitle as coreBaseTitle, mergeOpenLibrary as coreMerge, enrichWithYear, enrichItunesWithYear, scoreDocument as coreScoreDocument, filterAndSort as coreFilterAndSort, deduplicateByDisplay as coreDedup, deduplicateItunesByDisplay as coreDedupItunes, filterOlSupersededByItunes as coreOlMinusItunes, detectISBN, parseAuthorTitle, cleanTitle } from './core/search_core.js';
import { resizeImageToBase64 } from './core/image_utils.js';
(function(){
  const form=document.getElementById('entryForm'); if(!form) return; const coverPreview=document.getElementById('coverPreview'); const tileCoverClick=document.getElementById('tileCoverClick');
  const ui=document.getElementById('bookSearchUI'); const input=document.getElementById('bookSearchInput'); const resultsEl=document.getElementById('bookSearchResults');
  const editionNav=document.getElementById('editionNav'); const prevBtn=document.getElementById('prevEdition'); const nextBtn=document.getElementById('nextEdition'); const editionInfo=document.getElementById('editionInfo');
  const controls=document.getElementById('searchControls');
  const filtersToggle=document.getElementById('filtersToggle');
  const filtersActiveDot=document.getElementById('filtersActiveIndicator');
  const isMobile=()=>window.matchMedia('(max-width:599px)').matches;
  function syncFiltersVisibility(hasResults){
    if(!controls) return;
    if(!hasResults){ controls.style.display='none'; if(filtersToggle) filtersToggle.style.display='none'; return; }
    if(isMobile()){ if(filtersToggle) filtersToggle.style.display='inline-flex'; if(!controls.classList.contains('expanded')) controls.style.display='none'; else controls.style.display='flex'; }
    else{ controls.style.display='flex'; if(filtersToggle) filtersToggle.style.display='none'; }
  }
  function updateFilterIndicator(){
    if(!filtersActiveDot) return;
    filtersActiveDot.style.display=(activeFilter!=='all'||sortMode!=='relevance')?'inline-block':'none';
  }
  if(filtersToggle) filtersToggle.addEventListener('click',()=>{
    const isExpanded=controls.classList.toggle('expanded');
    filtersToggle.classList.toggle('open',isExpanded);
    filtersToggle.setAttribute('aria-expanded',isExpanded);
    controls.style.display=isExpanded?'flex':'none';
  });
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
  let debounceTimer=null; let currentWork=null; let currentAudio=null; let editions=[]; let editionIndex=0; let coverOnlyMode=false; let itunesCoverState=null;
  let searchCounter=0; // stale request detection for progressive loading
  let abortController=null; // cancels in-flight fetches on modal close or new search
  function markDirty(){ try{ form.dispatchEvent(new Event('input',{bubbles:true})); }catch{} }
  function showUI(isEdit){ ui.style.display=isEdit?'none':'block'; if(isEdit) clearSearchState(); }
  function clearSearchState(){ if(abortController){ abortController.abort(); abortController=null; } if(debounceTimer){ clearTimeout(debounceTimer); debounceTimer=null; } currentWork=null; currentAudio=null; editions=[]; editionIndex=0; coverOnlyMode=false; itunesCoverState=null; olDocs=[]; itunesItems=[]; input.value=''; resultsEl.innerHTML=''; resultsEl.style.display='none'; editionNav.style.display='none'; syncFiltersVisibility(false); if(controls) controls.classList.remove('expanded'); if(filtersToggle) filtersToggle.classList.remove('open'); lastQuery=''; queryTokens=[]; strictActive=false; sortMode='relevance'; activeFilter='all'; }
  function prepareQuery(q){ lastQuery=q.trim(); queryTokens=coreTokenize(lastQuery); }
  // Skeleton loading cards shown while APIs are in flight
  function showSkeletonCards(){
    resultsEl.innerHTML='<div class="search-status">Searching\u2026</div>'+
      '<div class="skeleton-result"><div class="skeleton-title"></div><div class="skeleton-author"></div></div>'.repeat(4);
  }
  // Progressive search: fires 3 APIs in parallel, renders results as each returns
  // Supports ISBN detection and "Title by Author" parsing for smarter queries
  async function searchTitle(q){ q=q.trim(); if(!q){ clearResults(); return; } prepareQuery(q);
    if(abortController) abortController.abort();
    abortController=new AbortController();
    const signal=abortController.signal;
    const mySearch=++searchCounter;
    const isStale=()=>mySearch!==searchCounter||signal.aborted;
    // Show skeleton immediately
    resultsEl.style.display='block'; showSkeletonCards();
    const termFull=encodeURIComponent(q); const base=coreBaseTitle(q);
    // Use fields parameter for 10x smaller payloads (OpenLibrary optimization)
    const fields='key,title,author_key,author_name,cover_i,first_publish_year,publish_year,subtitle,physical_format,language';
    // Build URLs — may be overridden by ISBN or author parsing
    let titleUrl='https://openlibrary.org/search.json?q='+encodeURIComponent(base)+'&limit=50&fields='+fields;
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
    function mergeAndRender(){ if(isStale()) return; olDocs=coreMerge(titleDocs,broadDocs); syncFiltersVisibility(olDocs.length+itunesItems.length>0); computeScoring(); renderCombined({failTitle,failBroad,partial:!titleDone||!broadDone||!itunesDone}); }
    // Fire title search (or ISBN search)
    fetch(titleUrl,{signal}).then(r=>r.json().then(j=>({ok:r.ok,...j})).catch(()=>({ok:false,docs:[]}))).catch(e=>{if(e.name==='AbortError')return null;return{ok:false,docs:[]};})
      .then(r=>{if(!r||isStale())return;failTitle=!r.ok;titleDocs=r.docs||[];titleDone=true;mergeAndRender();});
    // Fire broad search (skipped for ISBN queries)
    if(!skipBroad){ fetch(broadUrl,{signal}).then(r=>r.json().then(j=>({ok:r.ok,...j})).catch(()=>({ok:false,docs:[]}))).catch(e=>{if(e.name==='AbortError')return null;return{ok:false,docs:[]};})
      .then(r=>{if(!r||isStale())return;failBroad=!r.ok;broadDocs=r.docs||[];broadDone=true;mergeAndRender();}); }
    // Fire iTunes audiobook search
    fetch(itunesUrl,{signal}).then(r=>r.json()).catch(e=>{if(e.name==='AbortError')return null;return{results:[]};})
      .then(r=>{if(!r||isStale())return;itunesItems=r.results||[];itunesDone=true;mergeAndRender();});
  }
  function clearResults(){ resultsEl.innerHTML=''; resultsEl.style.display='none'; syncFiltersVisibility(false); }
  function enrich(){ enrichWithYear(olDocs); enrichItunesWithYear(itunesItems); }
  // scoring & strict filtering
  function computeScoring(){ if(!queryTokens.length){ strictActive=false; return; } let anyStrict=false;
    olDocs.forEach(d=>{ const a=(d.author_name&&d.author_name[0])||''; const result = coreScoreDocument({ title: d.title, subtitle: d.subtitle, author: a, queryTokens, queryString: lastQuery, sortMode, year: d._yearComputed||0 }); d._score=result.score; d._coverage=result.coverage; d._strict=result.strict; if(d._strict) anyStrict=true; });
    itunesItems.forEach(i=>{ const title=i.collectionName||i.trackName||''; const author=i.artistName||''; const result = coreScoreDocument({ title, subtitle: '', author, queryTokens, queryString: lastQuery, sortMode, year: i._yearComputed||0 }); i._score=result.score; i._coverage=result.coverage; i._strict=result.strict; if(i._strict) anyStrict=true; });
    strictActive=anyStrict; }
  function highlight(text){ if(!queryTokens.length) return text; let html=text; queryTokens.forEach(t=>{ const re=new RegExp('('+t.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')+')','ig'); html=html.replace(re,'<mark>$1</mark>'); }); return html; }
  function sorted(){ enrich(); return coreFilterAndSort({ olDocs, itunesItems, activeFilter, sortMode, strictActive }); }
  function renderCombined(flags){ const failTitle=flags&&flags.failTitle; const failBroad=flags&&flags.failBroad; const partial=flags&&flags.partial; const {ol,it}=sorted();
    const dedupIt=coreDedupItunes(it);
    const dedupOL=coreDedup(ol);
    const olFiltered=coreOlMinusItunes(dedupOL, dedupIt);
    const total=dedupIt.length+olFiltered.length;
    // Still loading and no results yet — keep skeleton visible
    if(partial && !total) return;
    const rows=[]; if(failTitle && failBroad){ rows.push('<div style="opacity:.55;font-size:.7rem;padding:2px 4px;color:#f87171">OpenLibrary unavailable (showing audio only / cached broader results if any).</div>'); }
    if(!total){ if(strictActive){ resultsEl.innerHTML='<div style="opacity:.5">No exact matches.</div>'; return; } resultsEl.innerHTML='<div style="opacity:.5">No results</div>'; return; }
    if(partial){ rows.push('<div class="search-status">'+total+' result'+(total!==1?'s':'')+', searching for more\u2026</div>'); }
    if(!strictActive && queryTokens.length){ rows.push('<div style="opacity:.55;font-size:.7rem;padding:2px 4px">No exact title match; showing broader results.</div>'); }
    if(failTitle && !failBroad){ rows.push('<div style="opacity:.45;font-size:.6rem;padding:2px 4px">Exact title search failed (fallback used).</div>'); }
    if(!failTitle && failBroad){ rows.push('<div style="opacity:.45;font-size:.6rem;padding:2px 4px">Broad search unavailable (exact only).</div>'); }
    const safeJson=(obj)=>encodeURIComponent(JSON.stringify(obj)).replace(/'/g,'%27');
    dedupIt.forEach(item=>{ const title=item._bestTitle||cleanTitle(item.collectionName||item.trackName||''); const author=item._bestAuthor||(item.artistName||''); const safe=highlight(title.replace(/</g,'&lt;')); const safeAuthor=highlight(author.replace(/</g,'&lt;')); const payload={ title, author, year:'', artwork:item.artworkUrl100||'', narrator:author, rawNarrators:author, olWorkKeys:item._olWorkKeys||[], olCovers:item._olCovers||[] }; rows.push(`<div class="res res-itunes" data-src="it" data-json='${safeJson(payload)}'>${safe} <span style="opacity:.6">${safeAuthor}</span></div>`); });
    olFiltered.forEach(d=>{ const title=d._bestTitle||cleanTitle(d.title||''); const sub=d.subtitle?(': '+d.subtitle):''; const safe=title.replace(/</g,'&lt;'); const safeSub=sub.replace(/</g,'&lt;'); const combined=highlight(safe+safeSub); const author=d._bestAuthor||((d.author_name&&d.author_name[0])?d.author_name[0]:''); const safeAuthor=highlight(author.replace(/</g,'&lt;')); const metaTitle=title+(d.subtitle?(': '+d.subtitle):''); rows.push(`<div class="res" data-src="ol" data-work='${d.key}' data-cover='${d.cover_i||''}' data-json='${safeJson({title:metaTitle,author,cover_i:d.cover_i||'',work_key:d.key})}'>${combined} <span style="opacity:.6">${safeAuthor}</span></div>`); }); if(!rows.length){ resultsEl.innerHTML='<div style="opacity:.5">No results</div>'; return; } resultsEl.innerHTML=rows.slice(0,60).join(''); }
  function selectWork(meta){ currentAudio=null; currentWork=meta; editions=[]; editionIndex=0; coverOnlyMode=false; editionNav.style.display='none';
    if(window.bookishApp?.clearCoverPreview) window.bookishApp.clearCoverPreview();
    populateFromBasic(meta); fetchEditions(meta); }
  function isEditionEnglishOrUnknown(ed){
    const langs=ed.languages||[];
    if(!langs.length) return true;
    return langs.some(l=>(l.key||'').includes('/eng'));
  }
  function editionCoverSort(a,b){
    const aCover=a.covers&&a.covers.length>0?0:1;
    const bCover=b.covers&&b.covers.length>0?0:1;
    return aCover-bCover;
  }
  async function fetchEditions(meta){ try{ const url='https://openlibrary.org'+meta.work_key+'/editions.json?limit=50'; const r=await fetch(url); const j=await r.json(); const all=(j.entries||j.editions||[]).filter(e=>e); const engOnly=all.filter(isEditionEnglishOrUnknown); editions=engOnly.length?engOnly:all; editions.sort(editionCoverSort);
    if(coverOnlyMode){
      const workTokens=coreTokenize(meta.title||'');
      editions=engOnly.filter(e=>{
        if(!e.covers||!e.covers.length) return false;
        if(!workTokens.length) return true;
        const edLower=((e.title||'')+(e.subtitle?' '+e.subtitle:'')).toLowerCase();
        let hits=0; workTokens.forEach(t=>{ if(edLower.includes(t)) hits++; });
        return hits/workTokens.length>=0.5;
      });
      if(editions.length){ editions.unshift({_itunesArtwork:true}); editionIndex=0; editionNav.style.display='flex'; editionInfo.textContent=`Cover 1 of ${editions.length}`; prevBtn.disabled=true; nextBtn.disabled=editions.length<=1; }
    } else if(editions.length){ editionIndex=0; editionNav.style.display='flex'; applyEdition(); }
    }catch(e){} }
  async function selectItunes(payload){ currentWork=null; editions=[]; editionIndex=0; editionNav.style.display='none'; currentAudio=payload;
    if(window.bookishApp?.clearCoverPreview) window.bookishApp.clearCoverPreview();
    form.title.value = cleanTitle(payload.title || '');
    form.author.value = payload.author || '';
    form.format.value=activeFilter==='audiobook'?'audio':'print';
    markDirty();
    // Fetch OL editions in background for cover browsing
    const hasOlWork = payload.olWorkKeys && payload.olWorkKeys.length;
    if(hasOlWork){ coverOnlyMode=true; fetchEditions({ work_key: payload.olWorkKeys[0], title: payload.title }); } else { coverOnlyMode=false; }
    if(payload.artwork){ const hi=payload.artwork.replace(/100x100/,'600x600');
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'loading');
      coverPreview.style.display = 'none';
      try{ const resp=await fetch(hi); if(resp.ok){ const blob=await resp.blob();
        const { base64, mime, wasResized, dataUrl } = await resizeImageToBase64(blob);
        if(wasResized) console.info('[Bookish] iTunes cover resized for storage efficiency');
        coverPreview.src=dataUrl; coverPreview.style.display='block'; coverPreview.dataset.b64=base64; coverPreview.dataset.mime=mime; if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${dataUrl}')`); if(ph) ph.style.display='none'; if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded(); itunesCoverState={dataUrl,base64,mime}; markDirty(); } else {
          setCoverPlaceholder(ph,'no-cover');
        } }catch(e){
        setCoverPlaceholder(ph,'no-cover');
      } } else {
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'no-cover');
    } }
  function populateFromBasic(meta){ if(!meta) return;
    form.title.value = cleanTitle(meta.title || '');
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

  function applyEdition(){ if(!editions.length||editionIndex<0) return; const ed=editions[editionIndex];
    if(!coverOnlyMode){ let changed=false; if(ed.title){ form.title.value=cleanTitle(ed.title); changed=true; } if(ed.authors&&ed.authors.length){ const names=ed.authors.map(a=> a.name || a.author && a.author.key || '').filter(Boolean); if(names.length){ form.author.value=names.join(', '); changed=true; } } if(ed.physical_format){ const fmt=(ed.physical_format||'').toLowerCase(); let mapped='print'; if(fmt.includes('ebook')||fmt.includes('e-book')||fmt.includes('kindle')) mapped='ebook'; else if(fmt.includes('audio')) mapped='audio'; form.format.value=mapped; changed=true; } if(changed) markDirty(); }
    if(ed._itunesArtwork && itunesCoverState){
      coverPreview.src=itunesCoverState.dataUrl; coverPreview.style.display='block'; coverPreview.dataset.b64=itunesCoverState.base64; coverPreview.dataset.mime=itunesCoverState.mime; if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${itunesCoverState.dataUrl}')`); const ph=document.getElementById('coverPlaceholder'); if(ph) ph.style.display='none'; if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded();
    } else if(ed.covers && ed.covers.length) {
      loadCoverById(ed.covers[0]);
    } else if(!ed._itunesArtwork) {
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'no-cover');
      coverPreview.src = '';
      coverPreview.style.display = 'none';
      delete coverPreview.dataset.b64;
      delete coverPreview.dataset.mime;
      if(tileCoverClick) tileCoverClick.style.removeProperty('--cover-url');
    }
    if(coverOnlyMode){ editionInfo.textContent=`Cover ${editionIndex+1} of ${editions.length}`; } else { editionInfo.textContent=editions.length>1?`Edition ${editionIndex+1} of ${editions.length} — use arrows to browse`:`1 edition`; }
    prevBtn.disabled=editionIndex===0; nextBtn.disabled=editionIndex===editions.length-1; }
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
      if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${dataUrl}')`);
      if(ph) ph.style.display = 'none';
      if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded();
      markDirty();
    } catch(e) {
      setCoverPlaceholder(ph,'no-cover');
    } }
  // blobToBase64 removed — now imported from core/image_utils.js via resizeImageToBase64
  input.addEventListener('input',()=>{ if(debounceTimer) clearTimeout(debounceTimer); debounceTimer=setTimeout(()=>searchTitle(input.value),350); });
  resultsEl.addEventListener('click',e=>{ const div=e.target.closest('div.res'); if(!div) return; resultsEl.style.display='none'; const src=div.dataset.src; try{ const meta=JSON.parse(decodeURIComponent(div.dataset.json)); if(src==='ol') selectWork(meta); else if(src==='it') selectItunes(meta); }catch(err){} });
  prevBtn.addEventListener('click',()=>{ if(editionIndex>0){ editionIndex--; applyEdition(); }});
  nextBtn.addEventListener('click',()=>{ if(editionIndex<editions.length-1){ editionIndex++; applyEdition(); }});
  if(controls){ controls.addEventListener('click',e=>{ const f=e.target.closest('.filter-btn'); const s=e.target.closest('.sort-btn'); if(f){ const val=f.dataset.filter; if(val && val!==activeFilter){ activeFilter=val; controls.querySelectorAll('.filter-btn').forEach(b=>b.classList.toggle('active', b.dataset.filter===activeFilter)); updateFilterIndicator(); renderCombined(); } }
    if(s){ const mode=s.dataset.mode; if(mode && mode!==sortMode){ sortMode=mode; controls.querySelectorAll('.sort-btn').forEach(b=>b.classList.toggle('active', b.dataset.mode===sortMode)); updateFilterIndicator(); renderCombined(); } }
  }); }
  window.bookSearch={ handleModalOpen(isEdit){ showUI(isEdit); } };
})();
