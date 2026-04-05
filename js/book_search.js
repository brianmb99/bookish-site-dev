// book_search.js
// Lightweight module to search OpenLibrary and populate the entry form
import { tokenize as coreTokenize, baseTitle as coreBaseTitle, mergeBookResults as coreMerge, enrichWithYear, enrichItunesWithYear, scoreDocument as coreScoreDocument, filterAndSort as coreFilterAndSort, deduplicateByDisplay as coreDedup, deduplicateItunesByDisplay as coreDedupItunes, filterBooksSupersededByItunes as coreBooksMinusItunes, detectISBN, parseAuthorTitle, cleanTitle, filterCoverMatches, extractISBN10s, amazonCoverUrl, olCoverByISBN, rankCover } from './core/search_core.js';
import { resizeImageToBase64 } from './core/image_utils.js';
(function(){
  const form=document.getElementById('entryForm'); if(!form) return; const coverPreview=document.getElementById('coverPreview'); const tileCoverClick=document.getElementById('tileCoverClick');
  const ui=document.getElementById('bookSearchUI'); const input=document.getElementById('bookSearchInput'); const resultsEl=document.getElementById('bookSearchResults');
  const prevBtn=document.getElementById('prevEdition'); const nextBtn=document.getElementById('nextEdition'); const editionInfo=document.getElementById('editionInfo');
  const findCoversBtn=document.getElementById('findCoversBtn');
  const uploadCoverBtn=document.getElementById('uploadCoverBtn');
  const coverFileInput=document.getElementById('hiddenCoverInput');
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
  let lastQuery=''; let queryTokens=[]; let strictActive=false;
  let olDocs=[]; let itunesItems=[];
  let debounceTimer=null; let currentWork=null; let currentAudio=null; let editions=[]; let editionIndex=0; let coverOnlyMode=false; let itunesCoverState=null;
  let searchCounter=0;
  let abortController=null;
  function markDirty(){ try{ form.dispatchEvent(new Event('input',{bubbles:true})); }catch{} }
  function showUI(isEdit){ ui.style.display=isEdit?'none':'block'; if(isEdit) clearSearchState(); }
  function showCoverNav(){ prevBtn.style.display='flex'; nextBtn.style.display='flex'; editionInfo.style.display='block'; }
  function hideCoverNav(){ prevBtn.style.display='none'; nextBtn.style.display='none'; editionInfo.style.display='none'; }
  function clearSearchState(){ if(abortController){ abortController.abort(); abortController=null; } if(debounceTimer){ clearTimeout(debounceTimer); debounceTimer=null; } currentWork=null; currentAudio=null; editions=[]; editionIndex=0; coverOnlyMode=false; itunesCoverState=null; olDocs=[]; itunesItems=[]; input.value=''; resultsEl.innerHTML=''; resultsEl.style.display='none'; hideCoverNav(); if(uploadCoverBtn) uploadCoverBtn.style.display='none'; lastQuery=''; queryTokens=[]; strictActive=false; sortMode='relevance'; activeFilter='all'; }
  function prepareQuery(q){ lastQuery=q.trim(); queryTokens=coreTokenize(lastQuery); }
  function showSkeletonCards(){
    resultsEl.innerHTML='<div class="search-status">Searching\u2026</div>'+
      '<div class="skeleton-result"><div class="skeleton-title"></div><div class="skeleton-author"></div></div>'.repeat(4);
  }
  async function searchTitle(q){ q=q.trim(); if(!q){ clearResults(); return; } prepareQuery(q);
    if(abortController) abortController.abort();
    abortController=new AbortController();
    const signal=abortController.signal;
    const mySearch=++searchCounter;
    const isStale=()=>mySearch!==searchCounter||signal.aborted;
    resultsEl.style.display='block'; showSkeletonCards();
    const termFull=encodeURIComponent(q); const base=coreBaseTitle(q);
    const olFields='key,title,subtitle,author_name,cover_i,first_publish_year,isbn,language,physical_format';
    let titleUrl='https://openlibrary.org/search.json?q='+encodeURIComponent(base)+'&limit=30&fields='+olFields;
    let broadUrl='https://openlibrary.org/search.json?q='+encodeURIComponent(q)+'&limit=30&fields='+olFields;
    const itunesUrl='https://itunes.apple.com/search?media=audiobook&term='+termFull+'&limit=25';
    let skipBroad=false;
    const isbn=detectISBN(q);
    if(isbn.isISBN){
      titleUrl='https://openlibrary.org/search.json?q=isbn:'+isbn.isbn+'&limit=20&fields='+olFields;
      skipBroad=true;
    } else {
      const parsed=parseAuthorTitle(q);
      if(parsed.author){
        titleUrl='https://openlibrary.org/search.json?title='+encodeURIComponent(parsed.title)+'&author='+encodeURIComponent(parsed.author)+'&limit=20&fields='+olFields;
      }
    }
    let titleDocs=[]; let broadDocs=[]; let failTitle=false; let failBroad=false;
    let titleDone=false; let broadDone=skipBroad; let itunesDone=false;
    function parseOLResponse(j){ return (j.docs||[]).map(d=>({
      key: d.key||'',
      title: d.title||'',
      subtitle: d.subtitle||'',
      author_name: d.author_name||[],
      first_publish_year: d.first_publish_year||0,
      cover_url: d.cover_i?`https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`:'',
      isbn: d.isbn||[],
      language: d.language||[]
    })).filter(Boolean); }
    function mergeAndRender(){ if(isStale()) return; olDocs=coreMerge(titleDocs,broadDocs); computeScoring(); renderCombined({failTitle,failBroad,partial:!titleDone||!broadDone||!itunesDone}); }
    fetch(titleUrl,{signal}).then(r=>r.json().then(j=>({ok:r.ok,...j})).catch(()=>({ok:false,docs:[]}))).catch(e=>{if(e.name==='AbortError')return null;return{ok:false,docs:[]};})
      .then(r=>{if(!r||isStale())return;failTitle=!r.ok;titleDocs=parseOLResponse(r);titleDone=true;mergeAndRender();});
    if(!skipBroad){ fetch(broadUrl,{signal}).then(r=>r.json().then(j=>({ok:r.ok,...j})).catch(()=>({ok:false,docs:[]}))).catch(e=>{if(e.name==='AbortError')return null;return{ok:false,docs:[]};})
      .then(r=>{if(!r||isStale())return;failBroad=!r.ok;broadDocs=parseOLResponse(r);broadDone=true;mergeAndRender();}); }
    fetch(itunesUrl,{signal}).then(r=>r.json()).catch(e=>{if(e.name==='AbortError')return null;return{results:[]};})
      .then(r=>{if(!r||isStale())return;itunesItems=r.results||[];itunesDone=true;mergeAndRender();});
  }
  function clearResults(){ resultsEl.innerHTML=''; resultsEl.style.display='none'; }
  function enrich(){ enrichWithYear(olDocs); enrichItunesWithYear(itunesItems); }
  function computeScoring(){ if(!queryTokens.length){ strictActive=false; return; } let anyStrict=false;
    olDocs.forEach(d=>{ const a=(d.author_name&&d.author_name[0])||''; const result = coreScoreDocument({ title: d.title, subtitle: d.subtitle, author: a, queryTokens, queryString: lastQuery, sortMode, year: d._yearComputed||0 }); d._score=result.score; d._coverage=result.coverage; d._strict=result.strict; if(d._strict) anyStrict=true; });
    itunesItems.forEach(i=>{ const title=i.collectionName||i.trackName||''; const author=i.artistName||''; const result = coreScoreDocument({ title, subtitle: '', author, queryTokens, queryString: lastQuery, sortMode, year: i._yearComputed||0 }); i._score=result.score; i._coverage=result.coverage; i._strict=result.strict; if(i._strict) anyStrict=true; });
    strictActive=anyStrict; }
  function highlight(text){ if(!queryTokens.length) return text; let html=text; queryTokens.forEach(t=>{ const re=new RegExp('('+t.replace(/[-/\\^$*+?.()|[\]{}]/g,'\\$&')+')','ig'); html=html.replace(re,'<mark>$1</mark>'); }); return html; }
  function sorted(){ enrich(); return coreFilterAndSort({ olDocs, itunesItems, activeFilter, sortMode, strictActive }); }
  function renderCombined(flags){ const failTitle=flags&&flags.failTitle; const failBroad=flags&&flags.failBroad; const partial=flags&&flags.partial; const {ol,it}=sorted();
    const dedupIt=coreDedupItunes(it);
    const dedupOL=coreDedup(ol);
    const booksFiltered=coreBooksMinusItunes(dedupOL, dedupIt);
    const total=dedupIt.length+booksFiltered.length;
    if(partial && !total) return;
    const rows=[]; if(failTitle && failBroad){ rows.push('<div style="opacity:.55;font-size:.7rem;padding:2px 4px;color:#f87171">Book search unavailable (showing audio only / cached broader results if any).</div>'); }
    if(!total){ if(strictActive){ resultsEl.innerHTML='<div style="opacity:.5">No exact matches.</div>'; return; } resultsEl.innerHTML='<div style="opacity:.5">No results</div>'; return; }
    if(partial){ rows.push('<div class="search-status">'+total+' result'+(total!==1?'s':'')+', searching for more\u2026</div>'); }
    if(!strictActive && queryTokens.length){ rows.push('<div style="opacity:.55;font-size:.7rem;padding:2px 4px">No exact title match; showing broader results.</div>'); }
    if(failTitle && !failBroad){ rows.push('<div style="opacity:.45;font-size:.6rem;padding:2px 4px">Exact title search failed (fallback used).</div>'); }
    if(!failTitle && failBroad){ rows.push('<div style="opacity:.45;font-size:.6rem;padding:2px 4px">Broad search unavailable (exact only).</div>'); }
    const safeJson=(obj)=>encodeURIComponent(JSON.stringify(obj)).replace(/'/g,'%27');
    dedupIt.forEach(item=>{ const title=item._bestTitle||cleanTitle(item.collectionName||item.trackName||''); const author=item._bestAuthor||(item.artistName||''); const safe=highlight(title.replace(/</g,'&lt;')); const safeAuthor=highlight(author.replace(/</g,'&lt;')); const payload={ title, author, year:'', artwork:item.artworkUrl100||'', narrator:author, rawNarrators:author, olWorkKeys:item._olWorkKeys||[], olCoverUrls:item._olCoverUrls||[] }; rows.push(`<div class="res res-itunes" data-src="it" data-json='${safeJson(payload)}'>${safe} <span style="opacity:.6">${safeAuthor}</span></div>`); });
    booksFiltered.forEach(d=>{ const title=d._bestTitle||cleanTitle(d.title||''); const sub=d.subtitle?(': '+d.subtitle):''; const safe=title.replace(/</g,'&lt;'); const safeSub=sub.replace(/</g,'&lt;'); const combined=highlight(safe+safeSub); const author=d._bestAuthor||((d.author_name&&d.author_name[0])?d.author_name[0]:''); const safeAuthor=highlight(author.replace(/</g,'&lt;')); const metaTitle=title+(d.subtitle?(': '+d.subtitle):''); rows.push(`<div class="res" data-src="ol" data-work='${d.key}' data-cover='${d.cover_url||''}' data-json='${safeJson({title:metaTitle,author,cover_url:d.cover_url||'',key:d.key})}'>${combined} <span style="opacity:.6">${safeAuthor}</span></div>`); }); if(!rows.length){ resultsEl.innerHTML='<div style="opacity:.5">No results</div>'; return; } resultsEl.innerHTML=rows.slice(0,60).join(''); }
  function selectWork(meta){ currentAudio=null; currentWork=meta; editions=[]; editionIndex=0; coverOnlyMode=false; hideCoverNav();
    if(window.bookishApp?.clearCoverPreview) window.bookishApp.clearCoverPreview();
    populateFromBasic(meta); loadEditionsFromSearch(meta); }
  const MIN_COVER_BYTES=2000;
  async function fetchAndValidateCover(url, source){
    try{
      const resp=await fetch(url);
      if(!resp.ok) return null;
      const blob=await resp.blob();
      if(blob.size<MIN_COVER_BYTES) return null;
      const { base64, mime, wasResized, dataUrl }=await resizeImageToBase64(blob);
      // Check dimensions via image load
      const dims=await new Promise(resolve=>{
        const img=new Image();
        img.onload=()=>resolve({w:img.naturalWidth,h:img.naturalHeight});
        img.onerror=()=>resolve(null);
        img.src=dataUrl;
      });
      if(!dims||dims.w<=10||dims.h<=10) return null;
      return { url, source, base64, mime, dataUrl, width:dims.w, height:dims.h };
    }catch{ return null; }
  }
  async function loadEditionsFromSearch(meta){
    const workKey=meta.key;
    if(!workKey) return;
    // Show skeleton loading state on cover tile
    const ph=document.getElementById('coverPlaceholder');
    if(ph){ ph.style.display='flex'; ph.innerHTML=''; ph.classList.add('cover-skeleton-pulse'); }
    coverPreview.style.display='none';
    if(editionInfo) editionInfo.textContent='Finding covers\u2026';
    let coverFirstShown=false;
    let rawEntries=[];
    try{
      const r=await fetch(`https://openlibrary.org${workKey}/editions.json?limit=50`);
      if(!r.ok){ if(ph) ph.classList.remove('cover-skeleton-pulse'); return; }
      const j=await r.json();
      rawEntries=j.entries||[];
    }catch{ if(ph) ph.classList.remove('cover-skeleton-pulse'); return; }
    // Build OL cover editions (non-Amazon)
    const olEditions=rawEntries.map(e=>({
      title: e.title||'',
      author_name: [],
      cover_url: e.covers&&e.covers.length?`https://covers.openlibrary.org/b/id/${e.covers[0]}-L.jpg`:'',
      language: e.languages?e.languages.map(l=>(l.key||'').replace('/languages/','')):[]
    }));
    const engOnly=olEditions.filter(e=>isEnglishBook(e));
    let baseEditions=(engOnly.length?engOnly:olEditions).slice();
    // Deduplicate OL editions by cover URL
    const seenCovers=new Set();
    baseEditions=baseEditions.filter(e=>{
      if(!e.cover_url) return true;
      if(seenCovers.has(e.cover_url)) return false;
      seenCovers.add(e.cover_url);
      return true;
    });
    baseEditions.sort(editionCoverSort);
    // Extract ISBN-10s and fetch Amazon covers progressively
    const isbn10s=extractISBN10s(rawEntries);
    const amazonPromises=isbn10s.map(isbn=>{
      const url=amazonCoverUrl(isbn);
      return fetchAndValidateCover(url,'amazon').then(result=>{
        if(!result) return;
        const ed={
          title: meta.title||'',
          author_name: [],
          cover_url: url,
          _coverData: result,
          _rank: rankCover(result)
        };
        // Insert into editions sorted by rank (best first)
        let inserted=false;
        for(let i=0;i<editions.length;i++){
          if((editions[i]._rank||0)<ed._rank){ editions.splice(i,0,ed); inserted=true; break; }
        }
        if(!inserted) editions.push(ed);
        // Auto-select first portrait cover if none shown yet
        if(!coverFirstShown && result.height/result.width>=1.18){
          coverFirstShown=true;
          editionIndex=editions.indexOf(ed);
          if(ph){ ph.classList.remove('cover-skeleton-pulse'); ph.style.display='none'; }
          coverPreview.src=result.dataUrl;
          coverPreview.style.display='block';
          coverPreview.style.animation='fadeIn 0.35s ease';
          coverPreview.dataset.b64=result.base64;
          coverPreview.dataset.mime=result.mime;
          if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${result.dataUrl}')`);
          if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded();
          markDirty();
        }
        // Show/update nav when 2+ editions with covers
        const withCovers=editions.filter(e=>e.cover_url);
        if(withCovers.length>=2){
          showCoverNav();
          prevBtn.style.animation='fadeIn 0.35s ease';
          nextBtn.style.animation='fadeIn 0.35s ease';
        }
        editionInfo.textContent=coverFirstShown?`Cover ${editionIndex+1} of ${withCovers.length}`:'Finding covers\u2026';
        prevBtn.disabled=editionIndex===0;
        nextBtn.disabled=editionIndex>=editions.length-1;
      });
    });
    // Also try OL cover-by-ISBN as secondary source
    const olIsbnPromises=isbn10s.slice(0,10).map(isbn=>{
      const url=olCoverByISBN(isbn);
      if(seenCovers.has(url)) return Promise.resolve();
      return fetchAndValidateCover(url,'ol').then(result=>{
        if(!result) return;
        seenCovers.add(url);
        const ed={
          title: meta.title||'',
          author_name: [],
          cover_url: url,
          _coverData: result,
          _rank: rankCover(result)
        };
        let inserted=false;
        for(let i=0;i<editions.length;i++){
          if((editions[i]._rank||0)<ed._rank){ editions.splice(i,0,ed); inserted=true; break; }
        }
        if(!inserted) editions.push(ed);
        if(!coverFirstShown && result.height/result.width>=1.18){
          coverFirstShown=true;
          editionIndex=editions.indexOf(ed);
          if(ph){ ph.classList.remove('cover-skeleton-pulse'); ph.style.display='none'; }
          coverPreview.src=result.dataUrl;
          coverPreview.style.display='block';
          coverPreview.style.animation='fadeIn 0.35s ease';
          coverPreview.dataset.b64=result.base64;
          coverPreview.dataset.mime=result.mime;
          if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${result.dataUrl}')`);
          if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded();
          markDirty();
        }
        const withCovers=editions.filter(e=>e.cover_url);
        if(withCovers.length>=2){ showCoverNav(); }
        editionInfo.textContent=coverFirstShown?`Cover ${editionIndex+1} of ${withCovers.length}`:'Finding covers\u2026';
        prevBtn.disabled=editionIndex===0;
        nextBtn.disabled=editionIndex>=editions.length-1;
      });
    });
    // Start with OL editions while Amazon covers load
    if(!coverOnlyMode){
      editions=baseEditions.slice();
      editions.forEach(e=>{ e._rank=e.cover_url?1:0; });
    }
    // Wait for all Amazon + OL-ISBN fetches
    await Promise.allSettled([...amazonPromises,...olIsbnPromises]);
    // Remove skeleton if still showing
    if(ph){ ph.classList.remove('cover-skeleton-pulse'); }
    if(coverOnlyMode){
      editions=filterCoverMatches(editions, meta.title);
      if(editions.length){ editions.unshift({_itunesArtwork:true}); editionIndex=0; showCoverNav(); editionInfo.textContent=`Cover 1 of ${editions.length}`; prevBtn.disabled=true; nextBtn.disabled=editions.length<=1; }
    } else if(!coverFirstShown && editions.length){
      // No portrait Amazon cover found — fall back to first available OL edition cover
      editionIndex=0;
      showCoverNav();
      applyEdition();
    } else if(coverFirstShown){
      // Update final count
      const withCovers=editions.filter(e=>e.cover_url);
      editionInfo.textContent=`Cover ${editionIndex+1} of ${withCovers.length}`;
      prevBtn.disabled=editionIndex===0;
      nextBtn.disabled=editionIndex>=editions.length-1;
    } else {
      // No covers at all
      setCoverPlaceholder(ph,'no-cover');
    }
  }
  function isEnglishBook(doc){
    if(!doc.language||!Array.isArray(doc.language)||!doc.language.length) return true;
    return doc.language.some(l=>l==='eng'||l==='en'||l==='English');
  }
  function editionCoverSort(a,b){
    const aCover=a.cover_url?0:1;
    const bCover=b.cover_url?0:1;
    return aCover-bCover;
  }
  async function selectItunes(payload){ currentWork=null; editions=[]; editionIndex=0; hideCoverNav(); currentAudio=payload;
    if(window.bookishApp?.clearCoverPreview) window.bookishApp.clearCoverPreview();
    form.title.value = cleanTitle(payload.title || '');
    form.author.value = payload.author || '';
    form.format.value=activeFilter==='audiobook'?'audio':'print';
    markDirty();
    const hasWorkKey = payload.olWorkKeys && payload.olWorkKeys.length;
    if(hasWorkKey){ coverOnlyMode=true; loadEditionsFromSearch({ key: payload.olWorkKeys[0], title: payload.title }); } else { coverOnlyMode=false; }
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
    if(meta.cover_url) {
      loadCoverByUrl(meta.cover_url);
    } else {
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'no-cover');
      coverPreview.style.display = 'none';
    } }
  function applyEdition(){ if(!editions.length||editionIndex<0) return; const ed=editions[editionIndex];
    if(!coverOnlyMode){ let changed=false; if(ed.title){ form.title.value=cleanTitle(ed.title); changed=true; } if(ed.author_name&&ed.author_name.length){ form.author.value=ed.author_name.join(', '); changed=true; } if(changed) markDirty(); }
    if(ed._itunesArtwork && itunesCoverState){
      coverPreview.src=itunesCoverState.dataUrl; coverPreview.style.display='block'; coverPreview.dataset.b64=itunesCoverState.base64; coverPreview.dataset.mime=itunesCoverState.mime; if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${itunesCoverState.dataUrl}')`); const ph=document.getElementById('coverPlaceholder'); if(ph) ph.style.display='none'; if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded();
    } else if(ed._coverData) {
      const cd=ed._coverData;
      coverPreview.src=cd.dataUrl; coverPreview.style.display='block'; coverPreview.dataset.b64=cd.base64; coverPreview.dataset.mime=cd.mime; if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${cd.dataUrl}')`); const ph=document.getElementById('coverPlaceholder'); if(ph) ph.style.display='none'; if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded(); markDirty();
    } else if(ed.cover_url) {
      loadCoverByUrl(ed.cover_url);
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
  async function loadCoverByUrl(coverUrl){ const ph = document.getElementById('coverPlaceholder');
    if(!coverUrl) {
      setCoverPlaceholder(ph,'no-cover');
      coverPreview.style.display = 'none';
      return;
    }
    setCoverPlaceholder(ph,'loading');
    coverPreview.style.display = 'none';
    try {
      const resp = await fetch(coverUrl);
      if(!resp.ok) {
        setCoverPlaceholder(ph,'no-cover');
        return;
      }
      const blob = await resp.blob();
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
  input.addEventListener('input',()=>{ if(debounceTimer) clearTimeout(debounceTimer); debounceTimer=setTimeout(()=>searchTitle(input.value),350); });
  resultsEl.addEventListener('click',e=>{ const div=e.target.closest('div.res'); if(!div) return; resultsEl.style.display='none'; const src=div.dataset.src; try{ const meta=JSON.parse(decodeURIComponent(div.dataset.json)); if(src==='ol') selectWork(meta); else if(src==='it') selectItunes(meta); }catch(err){} });
  prevBtn.addEventListener('click',(e)=>{ e.stopPropagation(); if(editionIndex>0){ editionIndex--; applyEdition(); }});
  nextBtn.addEventListener('click',(e)=>{ e.stopPropagation(); if(editionIndex<editions.length-1){ editionIndex++; applyEdition(); }});

  // --- "Find covers" for edit mode ---
  /** Fetch OpenLibrary results with covers, returning normalized docs. Returns [] on failure. */
  async function fetchOLCovers(query, maxResults){
    const fields='key,title,subtitle,author_name,cover_i,first_publish_year,isbn,language';
    try{
      const r=await fetch('https://openlibrary.org/search.json?q='+encodeURIComponent(query)+'&limit='+(maxResults||20)+'&fields='+fields);
      if(!r.ok) return [];
      const j=await r.json();
      return (j.docs||[]).filter(d=>d.cover_i).map(d=>({
        key: d.key||'',
        title: d.title||'',
        subtitle: d.subtitle||'',
        author_name: d.author_name||[],
        first_publish_year: d.first_publish_year||0,
        cover_url: `https://covers.openlibrary.org/b/id/${d.cover_i}-L.jpg`,
        isbn: d.isbn||[],
        language: d.language||[]
      }));
    }catch{ return []; }
  }
  // filterCoverMatches imported from search_core.js
  async function findCoversForEntry(title, author){
    if(!title) return;
    editions=[]; editionIndex=0; coverOnlyMode=true; itunesCoverState=null;
    if(findCoversBtn){ findCoversBtn.textContent='Searching\u2026'; findCoversBtn.classList.add('loading'); findCoversBtn.style.display='block'; }
    try{
      // Multiple search strategies to find diverse covers
      const queries=[];
      if(author) queries.push(`${title} ${author}`);
      queries.push(title);
      const itunesQ=author?`${title} ${author}`:title;
      const [allOLDocs, itRes]=await Promise.all([
        Promise.all(queries.map(q=>fetchOLCovers(q,20))).then(arrays=>{
          const seen=new Map();
          for(const arr of arrays){ for(const d of arr){ if(!seen.has(d.key)) seen.set(d.key,d); }}
          return Array.from(seen.values());
        }),
        fetch('https://itunes.apple.com/search?media=audiobook&term='+encodeURIComponent(itunesQ)+'&limit=5').then(r=>r.json()).catch(()=>({results:[]}))
      ]);
      const itItems=itRes.results||[];
      const bestIt=itItems[0];
      const currentCover=coverPreview.style.display==='block'?{dataUrl:coverPreview.src,base64:coverPreview.dataset.b64,mime:coverPreview.dataset.mime}:null;
      if(bestIt && bestIt.artworkUrl100){
        const hi=bestIt.artworkUrl100.replace(/100x100/,'600x600');
        try{
          const resp=await fetch(hi);
          if(resp.ok){ const blob=await resp.blob(); const { base64, mime, dataUrl }=await resizeImageToBase64(blob); itunesCoverState={dataUrl,base64,mime}; }
        }catch{}
      }
      // Fetch Amazon covers from OL edition ISBNs for work keys found
      const workKeys=[...new Set(allOLDocs.map(d=>d.key).filter(Boolean))];
      const amazonCovers=[];
      if(workKeys.length){
        // Fetch editions for first work key to get ISBNs
        try{
          const edR=await fetch(`https://openlibrary.org${workKeys[0]}/editions.json?limit=50`);
          if(edR.ok){
            const edJ=await edR.json();
            const isbn10s=extractISBN10s(edJ.entries||[]);
            const amazonResults=await Promise.allSettled(isbn10s.map(isbn=>
              fetchAndValidateCover(amazonCoverUrl(isbn),'amazon')
            ));
            for(const r of amazonResults){
              if(r.status==='fulfilled'&&r.value) amazonCovers.push(r.value);
            }
          }
        }catch{}
      }
      // Build editions: Amazon covers first (ranked), then OL covers
      const amazonEditions=amazonCovers.map(c=>({
        title: title,
        author_name: [],
        cover_url: c.url,
        _coverData: c,
        _rank: rankCover(c)
      }));
      amazonEditions.sort((a,b)=>(b._rank||0)-(a._rank||0));
      const olEditions=filterCoverMatches(allOLDocs, title);
      // Merge: Amazon first, then OL, dedup by cover URL
      const seenUrls=new Set();
      editions=[];
      for(const ed of [...amazonEditions,...olEditions]){
        const key=ed.cover_url;
        if(key && seenUrls.has(key)) continue;
        if(key) seenUrls.add(key);
        editions.push(ed);
      }
      if(itunesCoverState && editions.length){ editions.unshift({_itunesArtwork:true}); }
      if(editions.length && currentCover){
        editions.unshift({_currentCover:true});
      } else if(!editions.length && itunesCoverState){
        editions=[{_itunesArtwork:true}];
        if(currentCover) editions.unshift({_currentCover:true});
      }
      if(!editions.length || (editions.length===1 && editions[0]._currentCover)){
        hideCoverNav();
        if(findCoversBtn){ findCoversBtn.textContent='No covers available'; findCoversBtn.classList.remove('loading'); setTimeout(()=>{ findCoversBtn.textContent=currentCover?'Browse other covers':'Browse covers'; },2000); }
        return;
      }
      // Hide browse pill BEFORE showing nav to prevent overlap
      if(findCoversBtn){ findCoversBtn.classList.remove('loading'); findCoversBtn.style.display='none'; }
      editionIndex=0; showCoverNav();
      editionInfo.textContent=`Cover 1 of ${editions.length}`;
      prevBtn.disabled=true; nextBtn.disabled=editions.length<=1;
    }catch(e){
      if(findCoversBtn){ findCoversBtn.textContent='Search failed'; findCoversBtn.classList.remove('loading'); setTimeout(()=>{ findCoversBtn.textContent='Browse other covers'; },2000); }
    }
  }

  // Override applyEdition to also handle _currentCover sentinel
  const _origApplyEdition=applyEdition;
  applyEdition=function(){
    if(!editions.length||editionIndex<0) return;
    const ed=editions[editionIndex];
    if(ed._currentCover){
      // Restore the original cover — it's still on coverPreview (we haven't navigated away yet on first show)
      // The preview element retains its src/dataset from openModal, so just ensure it's visible
      const savedSrc=coverPreview.dataset._savedSrc;
      const savedB64=coverPreview.dataset._savedB64;
      const savedMime=coverPreview.dataset._savedMime;
      if(savedSrc){
        coverPreview.src=savedSrc; coverPreview.style.display='block';
        coverPreview.dataset.b64=savedB64||''; coverPreview.dataset.mime=savedMime||'';
        if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${savedSrc}')`);
        const ph=document.getElementById('coverPlaceholder'); if(ph) ph.style.display='none';
      }
      editionInfo.textContent=`Cover ${editionIndex+1} of ${editions.length}`;
      prevBtn.disabled=editionIndex===0; nextBtn.disabled=editionIndex===editions.length-1;
      markDirty();
      return;
    }
    _origApplyEdition();
  };

  if(findCoversBtn){
    findCoversBtn.addEventListener('click',(e)=>{
      e.stopPropagation();
      if(coverPreview.style.display==='block'){
        coverPreview.dataset._savedSrc=coverPreview.src;
        coverPreview.dataset._savedB64=coverPreview.dataset.b64||'';
        coverPreview.dataset._savedMime=coverPreview.dataset.mime||'';
      }
      const title=form.title.value.trim();
      const author=form.author.value.trim();
      findCoversForEntry(title, author);
    });
  }
  if(uploadCoverBtn && coverFileInput){
    uploadCoverBtn.addEventListener('click',(e)=>{ e.stopPropagation(); coverFileInput.click(); });
  }

  // Re-display cached results on focus (Fix 3: focus event re-displays search results)
  input.addEventListener('focus',()=>{
    if(!input.value.trim()) return;
    if(olDocs.length || itunesItems.length){ resultsEl.style.display='block'; }
    else { searchTitle(input.value); }
  });

  window.bookSearch={
    handleModalOpen(isEdit){ showUI(isEdit); hideCoverNav(); if(findCoversBtn) findCoversBtn.style.display='none'; if(uploadCoverBtn) uploadCoverBtn.style.display='block'; },
    showFindCoversBtn(hasCover){
      if(findCoversBtn){
        findCoversBtn.textContent=hasCover?'Browse other covers':'Browse covers';
        findCoversBtn.classList.remove('loading');
        findCoversBtn.style.display='block';
      }
    },
    selectWork(meta){ selectWork(meta); },
    selectItunes(payload){ selectItunes(payload); }
  };
})();
