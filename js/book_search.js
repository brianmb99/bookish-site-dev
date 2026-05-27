// book_search.js
// Lightweight module to search OpenLibrary and populate the entry form
import { cleanTitle, filterCoverMatches, extractISBN10s, amazonCoverUrl, olCoverByISBN, coverFitMode, coverSortComparator, convertISBN13to10 } from './core/search_core.js';
import { resizeImageToBase64 } from './core/image_utils.js';
import { buildOLEditions, filterEnglishRawEditions, insertByRank, buildCoverEdition, fetchAndValidateCover } from './core/cover_pipeline.js';
import { applyCoverCropToImage, normalizeCoverCrop, serializeCoverCrop } from './core/cover_crop.js';
(function(){
  const form=document.getElementById('entryForm'); if(!form) return; const coverPreview=document.getElementById('coverPreview'); const tileCoverClick=document.getElementById('tileCoverClick');
  const titleInput=form.elements?.namedItem('title');
  const authorInput=form.elements?.namedItem('author');
  // #114: in-modal #bookSearchUI (search input + results) deleted; the cover-edition
  // browser is now invoked via the "Browse covers" button via browseCoversForEntry(workKey).
  const prevBtn=document.getElementById('prevEdition'); const nextBtn=document.getElementById('nextEdition'); const editionInfo=document.getElementById('editionInfo');
  const findCoversBtn=document.getElementById('findCoversBtn');
  const uploadCoverBtn=document.getElementById('uploadCoverBtn');
  const coverFileInput=document.getElementById('hiddenCoverInput');
  const changeCoverLink=document.getElementById('changeCoverLink');
  const coverActionsEl=document.getElementById('coverActions');
  const coverBrowseControls=document.getElementById('coverBrowseControls');
  const coverBrowseApplyBtn=document.getElementById('coverBrowseApply');
  const coverBrowseCancelBtn=document.getElementById('coverBrowseCancel');
  // SVG book icon for cover placeholders (matches library card placeholder)
  const BOOK_SVG='<svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M4 19.5A2.5 2.5 0 0 1 6.5 17H20"/><path d="M6.5 2H20v20H6.5A2.5 2.5 0 0 1 4 19.5v-15A2.5 2.5 0 0 1 6.5 2z"/></svg>';
  function setCoverPlaceholder(ph,state){
    if(!ph) return;
    ph.style.display='flex';
    if(state==='loading') ph.innerHTML='<div class="placeholder-loading">Loading cover\u2026</div>';
    else if(state==='no-cover') ph.innerHTML='<div class="placeholder-icon">'+BOOK_SVG+'<span>Add cover</span></div>';
    else ph.innerHTML='<div class="placeholder-icon">'+BOOK_SVG+'<span>Add cover</span></div>';
  }
  let editions=[]; let editionIndex=0; let coverOnlyMode=false; let itunesCoverState=null;
  // Captured at search-result selection time and read by the form save handler.
  // Reset whenever the search state is cleared. See window.bookSearch.getSearchMeta().
  let currentWorkKey=''; let currentIsbn13='';
  let coverBrowseState=null;
  let coverBrowseGeneration=0;
  function pickIsbn13(isbnList){
    if(!Array.isArray(isbnList)) return '';
    for(const raw of isbnList){
      if(typeof raw!=='string') continue;
      const digits=raw.replace(/[^0-9Xx]/g,'');
      if(digits.length===13 && /^\d{13}$/.test(digits)) return digits;
    }
    return '';
  }
  function markDirty(){ try{ form.dispatchEvent(new Event('input',{bubbles:true})); }catch{} }
  function setPreviewCrop(crop){
    const normalized = normalizeCoverCrop(crop);
    if(normalized) coverPreview.dataset.crop = serializeCoverCrop(normalized);
    else delete coverPreview.dataset.crop;
    applyCoverCropToImage(coverPreview, normalized);
    return normalized;
  }
  function isExistingBookEdit(){ return !!form.elements?.namedItem('priorTxid')?.value; }
  function coverSnapshot(){
    return {
      hasCover: coverPreview.style.display==='block' && !!coverPreview.dataset.b64,
      src: coverPreview.src || '',
      b64: coverPreview.dataset.b64 || '',
      mime: coverPreview.dataset.mime || '',
      fit: coverPreview.dataset.fit || '',
      crop: coverPreview.dataset.crop || ''
    };
  }
  function storeCurrentCoverSentinel(){
    const snap=coverSnapshot();
    if(!snap.hasCover) return;
    coverPreview.dataset._savedSrc=snap.src;
    coverPreview.dataset._savedB64=snap.b64;
    coverPreview.dataset._savedMime=snap.mime;
    coverPreview.dataset._savedFit=snap.fit;
    coverPreview.dataset._savedCrop=snap.crop;
  }
  function clearCurrentCoverSentinel(){
    delete coverPreview.dataset._savedSrc;
    delete coverPreview.dataset._savedB64;
    delete coverPreview.dataset._savedMime;
    delete coverPreview.dataset._savedFit;
    delete coverPreview.dataset._savedCrop;
  }
  function restoreCoverSnapshot(snap){
    const ph=document.getElementById('coverPlaceholder');
    if(snap?.hasCover && snap.src){
      coverPreview.src=snap.src;
      coverPreview.style.display='block';
      coverPreview.dataset.b64=snap.b64 || '';
      if(snap.mime) coverPreview.dataset.mime=snap.mime; else delete coverPreview.dataset.mime;
      if(snap.fit) coverPreview.dataset.fit=snap.fit; else delete coverPreview.dataset.fit;
      setPreviewCrop(snap.crop || null);
      if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${snap.src}')`);
      if(ph) ph.style.display='none';
    } else {
      coverPreview.src='';
      coverPreview.style.display='none';
      delete coverPreview.dataset.b64;
      delete coverPreview.dataset.mime;
      delete coverPreview.dataset.fit;
      setPreviewCrop(null);
      if(tileCoverClick) tileCoverClick.style.removeProperty('--cover-url');
      setCoverPlaceholder(ph,'no-cover');
    }
    if(window.bookishApp?.showCoverLoaded && snap?.hasCover) window.bookishApp.showCoverLoaded();
    if(window.__bookishRefreshAdjustBtn) window.__bookishRefreshAdjustBtn();
    syncCoverBrowseApplyEnabled();
    markDirty();
  }
  function isCoverBrowsePending(){ return !!coverBrowseState; }
  function isStaleCoverBrowseGeneration(generation){
    return !!generation && (!coverBrowseState || coverBrowseState.generation !== generation);
  }
  function syncCoverBrowseApplyEnabled(){
    if(!coverBrowseApplyBtn) return;
    coverBrowseApplyBtn.disabled = !!coverBrowseState && !(coverPreview.style.display==='block' && !!coverPreview.dataset.b64);
  }
  function showCoverBrowseChrome(show){
    const inner=document.querySelector('.modal-inner');
    if(inner) inner.classList.toggle('browsing-cover', !!show);
    if(coverBrowseControls) coverBrowseControls.style.display=show?'flex':'none';
    syncCoverBrowseApplyEnabled();
  }
  function restoreCoverActionsAfterBrowse(){
    hideCoverNav();
    if(uploadCoverBtn) uploadCoverBtn.style.display='block';
    if(changeCoverLink){ changeCoverLink.style.display='block'; changeCoverLink.setAttribute('aria-expanded','false'); }
    if(coverActionsEl) coverActionsEl.style.display='none';
    if(findCoversBtn){
      const hasCover = coverPreview.style.display==='block' && !!coverPreview.dataset.b64;
      findCoversBtn.textContent = hasCover ? 'Browse other covers' : 'Browse covers';
      findCoversBtn.classList.remove('loading');
      findCoversBtn.style.display = currentWorkKey ? 'block' : 'none';
    }
  }
  function enterCoverBrowseMode(){
    if(!isExistingBookEdit()) return false;
    if(!coverBrowseState){
      coverBrowseGeneration += 1;
      coverBrowseState={ previous: coverSnapshot(), generation: coverBrowseGeneration };
    }
    showCoverBrowseChrome(true);
    return true;
  }
  function finishCoverBrowseMode({ restore=false, restoreActions=false } = {}){
    const state=coverBrowseState;
    coverBrowseState=null;
    coverBrowseGeneration += 1;
    showCoverBrowseChrome(false);
    clearCurrentCoverSentinel();
    if(restore && state) restoreCoverSnapshot(state.previous);
    if(restoreActions) restoreCoverActionsAfterBrowse();
    if(window.__bookishRefreshAdjustBtn) window.__bookishRefreshAdjustBtn();
  }
  function applyCoverBrowseSelection(){
    if(!coverBrowseState) return;
    if(coverPreview.style.display!=='block' || !coverPreview.dataset.b64) return;
    markDirty();
    finishCoverBrowseMode({ restore:false, restoreActions:true });
    if(isExistingBookEdit() && window.bookishApp?._autoSaveIfDirty){
      setTimeout(()=>{ try{ window.bookishApp._autoSaveIfDirty(); }catch{} }, 50);
    }
  }
  function cancelCoverBrowseSelection(){
    if(!coverBrowseState) return;
    finishCoverBrowseMode({ restore:true, restoreActions:true });
  }
  function showCoverNav(){ prevBtn.style.display='flex'; nextBtn.style.display='flex'; editionInfo.style.display='block'; if(changeCoverLink) changeCoverLink.style.display='none'; if(coverActionsEl) coverActionsEl.style.display='none'; }
  function hideCoverNav(){ prevBtn.style.display='none'; nextBtn.style.display='none'; editionInfo.style.display='none'; }
  function clearSearchState(){
    currentWorkKey=''; currentIsbn13='';
    editions=[]; editionIndex=0; coverOnlyMode=false; itunesCoverState=null;
    if(coverBrowseState) finishCoverBrowseMode({ restore:false });
    else showCoverBrowseChrome(false);
    clearCurrentCoverSentinel();
    hideCoverNav();
    if(uploadCoverBtn) uploadCoverBtn.style.display='none';
    if(changeCoverLink){ changeCoverLink.style.display='none'; changeCoverLink.setAttribute('aria-expanded','false'); }
    if(coverActionsEl) coverActionsEl.style.display='none';
  }
  function selectWork(meta){ editions=[]; editionIndex=0; coverOnlyMode=false; hideCoverNav();
    currentWorkKey=(meta&&typeof meta.key==='string')?meta.key:'';
    currentIsbn13=pickIsbn13(meta&&meta.isbn);
    if(window.bookishApp?.clearCoverPreview) window.bookishApp.clearCoverPreview();
    populateFromBasic(meta);
    if(!currentWorkKey){
      if(editionInfo) editionInfo.style.display='none';
      return;
    }
    // Suppress "Add cover" flash — we're about to load editions. Must run AFTER
    // populateFromBasic because that sets the placeholder back to "Add cover" too.
    const _ph0=document.getElementById('coverPlaceholder');
    if(_ph0){ _ph0.style.display='flex'; _ph0.innerHTML=''; _ph0.classList.add('cover-skeleton-pulse'); }
    if(editionInfo){ editionInfo.style.display='block'; editionInfo.textContent='Finding covers…'; }
    loadEditionsFromSearch(meta); }
  // fetchAndValidateCover imported from cover_pipeline.js; this local wrapper
  // injects the browser resize dependency used by cover_pipeline.
  // Wrap to inject resizeFn dependency
  function fetchAndValidateCoverLocal(url, source){
    return fetchAndValidateCover(url, source, { resizeFn: resizeImageToBase64 });
  }
  const GOOGLE_BOOKS_API_KEY='AIzaSyBz6feZWwzrOXaN5omMlarg1H_h3RgSzQk';
  async function fetchGoogleBooksISBNs(title, author){
    try{
      let q=encodeURIComponent(title);
      if(author) q+='+inauthor:'+encodeURIComponent(author);
      const url=`https://www.googleapis.com/books/v1/volumes?q=${q}&key=${GOOGLE_BOOKS_API_KEY}&maxResults=5&fields=items(volumeInfo/industryIdentifiers)`;
      const resp=await fetch(url);
      if(!resp.ok){ console.warn('[Bookish:Covers] Google Books API error:', resp.status); return []; }
      const data=await resp.json();
      const isbn10s=new Set();
      for(const item of (data.items||[])){
        for(const id of (item.volumeInfo?.industryIdentifiers||[])){
          if(id.type==='ISBN_10') isbn10s.add(id.identifier);
          else if(id.type==='ISBN_13'){ const c=convertISBN13to10(id.identifier); if(c) isbn10s.add(c); }
        }
      }
      console.info('[Bookish:Covers] Google Books returned %d ISBN-10s for "%s"', isbn10s.size, title);
      return [...isbn10s];
    }catch(err){ console.warn('[Bookish:Covers] Google Books fetch failed:', err?.message||err); return []; }
  }
  async function fetchOLISBNs(title, author){
    try{
      const url='https://openlibrary.org/search.json?title='+encodeURIComponent(title)+(author?'&author='+encodeURIComponent(author):'')+'&limit=5&fields=isbn';
      const resp=await fetch(url);
      if(!resp.ok){ console.warn('[Bookish:Covers] OL ISBN search error:', resp.status); return []; }
      const data=await resp.json();
      const isbn10s=new Set();
      for(const doc of (data.docs||[])){
        for(const raw of (doc.isbn||[])){
          const digits=String(raw||'').replace(/[^0-9X]/gi,'');
          if(digits.length===10) isbn10s.add(digits);
          else if(digits.length===13){ const c=convertISBN13to10(digits); if(c) isbn10s.add(c); }
        }
      }
      console.info('[Bookish:Covers] OL ISBN search returned %d ISBN-10s for "%s"', isbn10s.size, title);
      return [...isbn10s];
    }catch(err){ console.warn('[Bookish:Covers] OL ISBN search failed:', err?.message||err); return []; }
  }
  async function lookupOLWorkKey(title, author){
    try{
      const olFields='key,title,author_name';
      const url='https://openlibrary.org/search.json?title='+encodeURIComponent(title)+(author?'&author='+encodeURIComponent(author):'')+'&limit=5&fields='+olFields;
      const resp=await fetch(url);
      if(!resp.ok) return '';
      const data=await resp.json();
      const docs=data.docs||[];
      if(!docs.length) return '';
      const authorLow=(author||'').toLowerCase().trim();
      if(authorLow){
        const exact=docs.find(d=>(d.author_name||[]).some(a=>a.toLowerCase()===authorLow));
        if(exact && exact.key) return exact.key;
      }
      return docs[0].key||'';
    }catch(err){ console.warn('[Bookish:Covers] OL workkey lookup failed:', err?.message||err); return ''; }
  }
  async function loadCoversFromGoogleBooks(title, author){
    const browseGenerationAtStart=coverBrowseState?.generation || 0;
    // Reserve the tile-cover space so the modal doesn't resize when the cover lands.
    const inner=document.querySelector('.modal-inner');
    if(inner) inner.classList.remove('no-cover');
    const ph=document.getElementById('coverPlaceholder');
    if(ph){ ph.style.display='flex'; ph.innerHTML=''; ph.classList.add('cover-skeleton-pulse'); }
    coverPreview.style.display='none';
    syncCoverBrowseApplyEnabled();
    if(editionInfo){ editionInfo.style.display='block'; editionInfo.textContent='Finding covers…'; }
    function paintItunesFallback(){
      if(isStaleCoverBrowseGeneration(browseGenerationAtStart)) return;
      if(itunesCoverState && itunesCoverState.width){
        editions=[buildCoverEdition(itunesCoverState, { title })];
        editionIndex=0;
        showCoverNav();
        applyEdition();
        editionInfo.textContent=`Cover 1 of ${editions.length}`;
        prevBtn.disabled=true; nextBtn.disabled=true;
      } else if(isCoverBrowsePending()){
        cancelCoverBrowseSelection();
      } else if(ph){ setCoverPlaceholder(ph,'no-cover'); }
    }
    // Try OL ISBN search first (no key required, more reliable); fall back to Google Books.
    let isbn10s=await fetchOLISBNs(title, author);
    if(!isbn10s.length){ isbn10s=await fetchGoogleBooksISBNs(title, author); }
    if(!isbn10s.length){ paintItunesFallback(); return; }
    const seenFingerprints=new Set();
    const coverPromises=isbn10s.map(isbn=>
      fetchAndValidateCoverLocal(amazonCoverUrl(isbn),'amazon').then(result=>{
        if(!result) return;
        if(result.fingerprint && seenFingerprints.has(result.fingerprint)) return;
        if(result.fingerprint) seenFingerprints.add(result.fingerprint);
        const ed=buildCoverEdition(result, { title });
        editions.push(ed);
      })
    );
    await Promise.allSettled(coverPromises);
    if(isStaleCoverBrowseGeneration(browseGenerationAtStart)) return;
    if(!editions.length){ paintItunesFallback(); return; }
    editions.sort(coverSortComparator);
    // Include iTunes cover if available
    if(itunesCoverState && itunesCoverState.width){
      const itunesEd=buildCoverEdition(itunesCoverState, { title });
      const fp=itunesCoverState.fingerprint;
      if(!fp || !seenFingerprints.has(fp)) editions.push(itunesEd);
    }
    editions.sort(coverSortComparator);
    editionIndex=0;
    showCoverNav();
    applyEdition();
    editionInfo.textContent=`Cover 1 of ${editions.length}`;
    prevBtn.disabled=true;
    nextBtn.disabled=editions.length<=1;
    const best=editions[0];
    console.info('[Bookish:Covers] Google Books pipeline: %d covers, best rank=%d source=%s %dx%d', editions.length, best?._rank||0, best?._coverData?.source||'n/a', best?._coverData?.width||0, best?._coverData?.height||0);
  }
  async function loadEditionsFromSearch(meta){
    const browseGenerationAtStart=coverBrowseState?.generation || 0;
    const workKey=meta.key;
    if(!workKey){ console.warn('[Bookish:Covers] loadEditionsFromSearch: no workKey, skipping'); return; }
    console.info('[Bookish:Covers] loadEditionsFromSearch: workKey=%s, title=%s, coverOnlyMode=%s', workKey, meta.title, coverOnlyMode);
    // Reserve the tile-cover space so the modal doesn't resize when the cover lands.
    const inner=document.querySelector('.modal-inner');
    if(inner) inner.classList.remove('no-cover');
    // Show skeleton loading state on cover tile
    const ph=document.getElementById('coverPlaceholder');
    if(ph){ ph.style.display='flex'; ph.innerHTML=''; ph.classList.add('cover-skeleton-pulse'); }
    coverPreview.style.display='none';
    syncCoverBrowseApplyEnabled();
    if(editionInfo){ editionInfo.style.display='block'; editionInfo.textContent='Finding covers\u2026'; }
    function paintItunesFallback(){
      if(isStaleCoverBrowseGeneration(browseGenerationAtStart)) return;
      if(ph) ph.classList.remove('cover-skeleton-pulse');
      if(itunesCoverState && itunesCoverState.width){
        editions=[buildCoverEdition(itunesCoverState, { title: meta.title })];
        editionIndex=0;
        showCoverNav();
        applyEdition();
        editionInfo.textContent=`Cover 1 of ${editions.length}`;
        prevBtn.disabled=true; nextBtn.disabled=true;
      } else if(isCoverBrowsePending()){
        cancelCoverBrowseSelection();
      } else if(ph){ setCoverPlaceholder(ph,'no-cover'); }
    }
    let rawEntries=[];
    try{
      const edController=new AbortController();
      const edTimeout=setTimeout(()=>edController.abort(),8000);
      const r=await fetch(`https://openlibrary.org${workKey}/editions.json?limit=50`,{signal:edController.signal});
      clearTimeout(edTimeout);
      if(!r.ok){ paintItunesFallback(); return; }
      const j=await r.json();
      rawEntries=j.entries||[];
    }catch(err){ console.warn('[Bookish:Covers] OL editions fetch failed:', err?.message||err); paintItunesFallback(); return; }
    // Build OL cover editions (non-Amazon)
    const { editions: baseEditions, seenCovers } = buildOLEditions(rawEntries);
    // Extract ISBN-10s and fetch Amazon covers progressively.
    // #209: pull ISBNs only from English-language editions so Amazon doesn't
    // surface foreign-language covers (the highest-ranked Amazon hit would
    // otherwise win the top slot even when the user typed an English query).
    const englishRaw=filterEnglishRawEditions(rawEntries);
    const isbn10s=extractISBN10s(englishRaw);
    console.info('[Bookish:Covers] OL editions: %d entries, %d OL covers, %d ISBN-10s', rawEntries.length, baseEditions.filter(e=>e.cover_url).length, isbn10s.length);
    const seenFingerprints=new Set();
    const amazonPromises=isbn10s.map(isbn=>{
      const url=amazonCoverUrl(isbn);
      return fetchAndValidateCoverLocal(url,'amazon').then(result=>{
        if(!result) return;
        if(result.fingerprint && seenFingerprints.has(result.fingerprint)) return;
        if(result.fingerprint) seenFingerprints.add(result.fingerprint);
        const ed=buildCoverEdition(result, meta);
        insertByRank(editions, ed);
      });
    });
    // Also try OL cover-by-ISBN as secondary source (no auto-select — Amazon preferred)
    const olIsbnPromises=isbn10s.slice(0,10).map(isbn=>{
      const url=olCoverByISBN(isbn);
      if(seenCovers.has(url)) return Promise.resolve();
      return fetchAndValidateCoverLocal(url,'ol').then(result=>{
        if(!result) return;
        if(result.fingerprint && seenFingerprints.has(result.fingerprint)) return;
        if(result.fingerprint) seenFingerprints.add(result.fingerprint);
        seenCovers.add(url);
        const ed=buildCoverEdition(result, meta);
        insertByRank(editions, ed);
      });
    });
    // Start with OL editions while Amazon covers load
    if(!coverOnlyMode){
      editions=baseEditions.slice();
      editions.forEach(e=>{ e._rank=e.cover_url?1:0; });
    }
    // Wait for all Amazon + OL-ISBN fetches, with 15s overall timeout
    const allFetches=Promise.allSettled([...amazonPromises,...olIsbnPromises]);
    const pipelineTimeout=new Promise(resolve=>setTimeout(resolve,15000));
    await Promise.race([allFetches,pipelineTimeout]);
    if(isStaleCoverBrowseGeneration(browseGenerationAtStart)) return;
    // Remove skeleton if still showing
    if(ph){ ph.classList.remove('cover-skeleton-pulse'); }
    const amzCovers=editions.filter(e=>e._coverData&&e._coverData.source==='amazon').length;
    const olIsbnCovers=editions.filter(e=>e._coverData&&e._coverData.source==='ol').length;
    console.info('[Bookish:Covers] Pipeline done: %d editions total (%d Amazon, %d OL-ISBN, %d deduped)', editions.length, amzCovers, olIsbnCovers, seenFingerprints.size - editions.length);
    if(coverOnlyMode){
      editions=filterCoverMatches(editions, meta.title);
      // Include iTunes cover if available (from selectItunes flow)
      if(itunesCoverState && itunesCoverState.width){
        const itunesEd=buildCoverEdition(itunesCoverState, { title: meta.title });
        const fp=itunesCoverState.fingerprint;
        if(!fp || !seenFingerprints.has(fp)){
          if(fp) seenFingerprints.add(fp);
          editions.push(itunesEd);
        }
      }
    }
    if(editions.length){
      editions.sort(coverSortComparator);
      editionIndex=0;
      showCoverNav();
      applyEdition();
      editionInfo.textContent=`Cover 1 of ${editions.length}`;
      prevBtn.disabled=true;
      nextBtn.disabled=editions.length<=1;
      const best=editions[0];
      console.info('[Bookish:Covers] Best cover: rank=%d, source=%s, %dx%d', best?._rank||0, best?._coverData?.source||'n/a', best?._coverData?.width||0, best?._coverData?.height||0);
    } else {
      paintItunesFallback();
    }
  }
  async function selectItunes(payload){ editions=[]; editionIndex=0; hideCoverNav();
    currentWorkKey=(payload&&Array.isArray(payload.olWorkKeys)&&payload.olWorkKeys.length)?String(payload.olWorkKeys[0]||''):'';
    currentIsbn13='';
    if(window.bookishApp?.clearCoverPreview) window.bookishApp.clearCoverPreview();
    // clearCoverPreview baked "Add cover" markup into the placeholder. We're
    // about to fetch covers, so immediately swap to the loading skeleton state
    // so the user never sees "Add cover" text flash before the cover lands.
    const _ph0=document.getElementById('coverPlaceholder');
    if(_ph0){ _ph0.style.display='flex'; _ph0.innerHTML=''; _ph0.classList.add('cover-skeleton-pulse'); }
    if(editionInfo){ editionInfo.style.display='block'; editionInfo.textContent='Finding covers…'; }
    if(titleInput) titleInput.value = cleanTitle(payload.title || '');
    if(authorInput) authorInput.value = payload.author || '';
    markDirty();
    const hasWorkKey = payload.olWorkKeys && payload.olWorkKeys.length;
    console.info('[Bookish:Covers] selectItunes: title=%s, hasWorkKey=%s, olWorkKeys=%o', payload.title, hasWorkKey, payload.olWorkKeys);
    coverOnlyMode=true;
    if(hasWorkKey){
      loadEditionsFromSearch({ key: payload.olWorkKeys[0], title: payload.title });
    } else {
      // Race recovery: omnibox renders iTunes results before OL merges in, so a fast
      // click may arrive with no workKey. Try OL lookup before the Google Books fallback.
      lookupOLWorkKey(payload.title, payload.author).then(wk => {
        if(wk){
          console.info('[Bookish:Covers] selectItunes race-recovered OL workKey %s', wk);
          currentWorkKey = wk;
          loadEditionsFromSearch({ key: wk, title: payload.title });
        } else {
          loadCoversFromGoogleBooks(payload.title, payload.author);
        }
      });
    }
    if(payload.artwork){ const hi=payload.artwork.replace(/100x100/,'600x600');
      // Fetch the iTunes artwork into itunesCoverState but DON'T paint it yet.
      // loadEditionsFromSearch / loadCoversFromGoogleBooks will include it as a
      // candidate in the editions array and applyEdition will pick the best one
      // (Amazon-portrait typically outranks iTunes-square). This avoids the
      // flash of low-res iTunes thumbnail before the higher-quality cover lands.
      try{ const result=await fetchAndValidateCoverLocal(hi,'itunes');
        if(result){ itunesCoverState=result; }
      }catch(e){ /* swallow — pipeline still runs without iTunes fallback */ }
    } }
  function populateFromBasic(meta){ if(!meta) return;
    if(titleInput) titleInput.value = cleanTitle(meta.title || '');
    if(meta.author && authorInput) authorInput.value = meta.author;
    markDirty();
    if(meta.cover_url) {
      loadCoverByUrl(meta.cover_url);
    } else {
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'no-cover');
      coverPreview.style.display = 'none';
      setPreviewCrop(null);
      syncCoverBrowseApplyEnabled();
    } }
  function applyEdition(){ if(!editions.length||editionIndex<0) return;
    // If an Adjust session is in progress, late-arriving edition swaps from
    // the async cover pipeline must not clobber the user's current pan/zoom.
    // (typeof guard handles the rare case of an early call before isAdjusting
    // is defined in the IIFE scope — function declarations hoist, but defensive.)
    if(typeof isAdjusting === 'function' && isAdjusting()) return;
    const ed=editions[editionIndex];
    if(!coverOnlyMode){ let changed=false; if(ed.title && titleInput){ titleInput.value=cleanTitle(ed.title); changed=true; } if(ed.author_name&&ed.author_name.length&&authorInput){ authorInput.value=ed.author_name.join(', '); changed=true; } if(changed) markDirty(); }
    if(ed._coverData) {
      const cd=ed._coverData;
      coverPreview.src=cd.dataUrl; coverPreview.style.display='block'; coverPreview.dataset.b64=cd.base64; coverPreview.dataset.mime=cd.mime; coverPreview.dataset.fit=coverFitMode(cd.width, cd.height); setPreviewCrop(null); if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${cd.dataUrl}')`); const ph=document.getElementById('coverPlaceholder'); if(ph) ph.style.display='none'; if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded(); if(window.__bookishRefreshAdjustBtn) window.__bookishRefreshAdjustBtn(); markDirty();
    } else if(ed.cover_url) {
      loadCoverByUrl(ed.cover_url);
    } else {
      const ph = document.getElementById('coverPlaceholder');
      setCoverPlaceholder(ph,'no-cover');
      coverPreview.src = '';
      coverPreview.style.display = 'none';
      delete coverPreview.dataset.b64;
      delete coverPreview.dataset.mime;
      delete coverPreview.dataset.fit;
      setPreviewCrop(null);
      if(tileCoverClick) tileCoverClick.style.removeProperty('--cover-url');
      if(window.__bookishRefreshAdjustBtn) window.__bookishRefreshAdjustBtn();
    }
    if(coverOnlyMode){ editionInfo.textContent=`Cover ${editionIndex+1} of ${editions.length}`; } else { editionInfo.textContent=editions.length>1?`Edition ${editionIndex+1} of ${editions.length} — use arrows to browse`:`1 edition`; }
    prevBtn.disabled=editionIndex===0; nextBtn.disabled=editionIndex===editions.length-1; syncCoverBrowseApplyEnabled(); }
  form && form.addEventListener('booksearch:applied', markDirty);
  async function loadCoverByUrl(coverUrl){ const ph = document.getElementById('coverPlaceholder');
    const browseGenerationAtStart=coverBrowseState?.generation || 0;
    if(!coverUrl) {
      setCoverPlaceholder(ph,'no-cover');
      coverPreview.style.display = 'none';
      setPreviewCrop(null);
      syncCoverBrowseApplyEnabled();
      return;
    }
    setCoverPlaceholder(ph,'loading');
    coverPreview.style.display = 'none';
    syncCoverBrowseApplyEnabled();
    try {
      const resp = await fetch(coverUrl);
      if(!resp.ok) {
        setCoverPlaceholder(ph,'no-cover');
        return;
      }
      const blob = await resp.blob();
      const { base64, mime, wasResized, dataUrl, width, height } = await resizeImageToBase64(blob);
      // Late-arriving fetch must not clobber an active Adjust session.
      if(typeof isAdjusting === 'function' && isAdjusting()) return;
      if(isStaleCoverBrowseGeneration(browseGenerationAtStart)) return;
      if(wasResized) console.info('[Bookish] Cover resized for storage efficiency');
      coverPreview.src = dataUrl;
      coverPreview.style.display = 'block';
      coverPreview.dataset.b64 = base64;
      coverPreview.dataset.mime = mime;
      coverPreview.dataset.fit = coverFitMode(width, height);
      setPreviewCrop(null);
      if(tileCoverClick) tileCoverClick.style.setProperty('--cover-url',`url('${dataUrl}')`);
      if(ph) ph.style.display = 'none';
      if(window.bookishApp?.showCoverLoaded) window.bookishApp.showCoverLoaded();
      if(window.__bookishRefreshAdjustBtn) window.__bookishRefreshAdjustBtn();
      syncCoverBrowseApplyEnabled();
      markDirty();
    } catch(e) {
      setCoverPlaceholder(ph,'no-cover');
      syncCoverBrowseApplyEnabled();
    } }
  // #114: in-modal search input + results were deleted. No input/result listeners.
  // Edition arrows still operate on `editions` populated by browseCoversForEntry().
  prevBtn.addEventListener('click',(e)=>{
    e.stopPropagation();
    if(editionIndex>0){ editionIndex--; applyEdition(); _autoSaveCoverChange(); }
  });
  nextBtn.addEventListener('click',(e)=>{
    e.stopPropagation();
    if(editionIndex<editions.length-1){ editionIndex++; applyEdition(); _autoSaveCoverChange(); }
  });
  function _autoSaveCoverChange(){
    if(isCoverBrowsePending()) return;
    // In view mode, auto-save the new cover after a brief delay so the preview
    // settles. The cover swap already markDirty()'d the form. (#114)
    if(window.bookishApp?._autoSaveIfDirty){
      setTimeout(()=>{ try{ window.bookishApp._autoSaveIfDirty(); }catch{} }, 50);
    }
  }

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
    const browseGenerationAtStart=coverBrowseState?.generation || 0;
    console.info('[Bookish:Covers] findCoversForEntry: title=%s, author=%s', title, author);
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
      if(isStaleCoverBrowseGeneration(browseGenerationAtStart)) return;
      const bestIt=itItems[0];
      const currentCover=coverPreview.style.display==='block'?{dataUrl:coverPreview.src,base64:coverPreview.dataset.b64,mime:coverPreview.dataset.mime}:null;
      let itunesCover=null;
      if(bestIt && bestIt.artworkUrl100){
        const hi=bestIt.artworkUrl100.replace(/100x100/,'600x600');
        try{ itunesCover=await fetchAndValidateCoverLocal(hi,'itunes'); }catch{}
      }
      // Fetch Amazon covers from OL print-variant ISBNs for work keys found
      const workKeys=[...new Set(allOLDocs.map(d=>d.key).filter(Boolean))];
      console.info('[Bookish:Covers] findCovers: %d OL docs, %d work keys, first=%s', allOLDocs.length, workKeys.length, workKeys[0]||'none');
      const amazonCovers=[];
      let isbn10s=[];
      if(workKeys.length){
        // Fetch editions for first work key to get ISBNs
        try{
          const edController=new AbortController();
          const edTimeout=setTimeout(()=>edController.abort(),8000);
          const edR=await fetch(`https://openlibrary.org${workKeys[0]}/editions.json?limit=50`,{signal:edController.signal});
          clearTimeout(edTimeout);
          if(edR.ok){
            const edJ=await edR.json();
            // #209: English-filter raw editions before ISBN extraction so Amazon
            // doesn't pull foreign-language covers via foreign editions.
            const englishRaw=filterEnglishRawEditions(edJ.entries||[]);
            isbn10s=extractISBN10s(englishRaw);
            console.info('[Bookish:Covers] findCovers: %d editions (%d English), %d ISBN-10s for Amazon fetch', (edJ.entries||[]).length, englishRaw.length, isbn10s.length);
          }
        }catch(err){ console.warn('[Bookish:Covers] findCovers editions/Amazon fetch error:', err?.message||err); }
      }
      // Fallback to Google Books if no ISBNs from OL
      if(!isbn10s.length){
        isbn10s=await fetchGoogleBooksISBNs(title, author);
      }
      if(isStaleCoverBrowseGeneration(browseGenerationAtStart)) return;
      if(isbn10s.length){
        const amazonResults=await Promise.allSettled(isbn10s.map(isbn=>
          fetchAndValidateCoverLocal(amazonCoverUrl(isbn),'amazon')
        ));
        if(isStaleCoverBrowseGeneration(browseGenerationAtStart)) return;
        for(const r of amazonResults){
          if(r.status==='fulfilled'&&r.value) amazonCovers.push(r.value);
        }
        console.info('[Bookish:Covers] findCovers: %d/%d Amazon covers valid', amazonCovers.length, isbn10s.length);
      }
      // Build editions: Amazon covers (ranked), iTunes if available, then OL covers
      const amazonEditions=amazonCovers.map(c=>buildCoverEdition(c, { title }));
      const itunesEditions=itunesCover?[buildCoverEdition(itunesCover, { title })]:[];
      const olEditions=filterCoverMatches(allOLDocs, title);
      // Merge all sources, dedup by cover URL + image fingerprint
      const seenUrls=new Set();
      const seenFps=new Set();
      editions=[];
      for(const ed of [...amazonEditions,...itunesEditions,...olEditions]){
        const key=ed.cover_url;
        if(key && seenUrls.has(key)) continue;
        if(key) seenUrls.add(key);
        const fp=ed._coverData?.fingerprint;
        if(fp && seenFps.has(fp)) continue;
        if(fp) seenFps.add(fp);
        editions.push(ed);
      }
      editions.sort(coverSortComparator);
      if(editions.length && currentCover){
        editions.unshift({_currentCover:true});
      }
      console.info('[Bookish:Covers] findCovers result: %d Amazon, %d iTunes, %d OL, %d total editions', amazonEditions.length, itunesEditions.length, olEditions.length, editions.length);
      if(!editions.length || (editions.length===1 && editions[0]._currentCover)){
        hideCoverNav();
        if(isCoverBrowsePending()) cancelCoverBrowseSelection();
        if(findCoversBtn){ findCoversBtn.textContent='No covers available'; findCoversBtn.classList.remove('loading'); setTimeout(()=>{ findCoversBtn.textContent=currentCover?'Browse other covers':'Browse covers'; },2000); }
        return;
      }
      // Hide browse pill BEFORE showing nav to prevent overlap
      if(findCoversBtn){ findCoversBtn.classList.remove('loading'); findCoversBtn.style.display='none'; }
      editionIndex=0; showCoverNav();
      editionInfo.textContent=`Cover 1 of ${editions.length}`;
      prevBtn.disabled=true; nextBtn.disabled=editions.length<=1;
    }catch(e){
      if(isCoverBrowsePending()) cancelCoverBrowseSelection();
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
      const savedFit=coverPreview.dataset._savedFit||'';
      const savedCrop=coverPreview.dataset._savedCrop||'';
      if(savedSrc){
        coverPreview.src=savedSrc; coverPreview.style.display='block';
        coverPreview.dataset.b64=savedB64||''; coverPreview.dataset.mime=savedMime||'';
        if(savedFit) coverPreview.dataset.fit=savedFit; else delete coverPreview.dataset.fit;
        setPreviewCrop(savedCrop);
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
      // #114: always go through the new decoupled entry point. Uses workKey
      // when available, otherwise falls back to title/author search.
      browseCoversForEntry(currentWorkKey);
    });
  }

  // ---------------------------------------------------------------
  // Per-cover Adjust (zoom + pan) — issue #148
  // ---------------------------------------------------------------
  // State scoped to a single Adjust session. Reset on Apply/Cancel/modal-close.
  const adjustBtn=document.getElementById('coverAdjustBtn');
  const adjustControls=document.getElementById('coverAdjustControls');
  const adjustZoom=document.getElementById('coverAdjustZoom');
  const adjustApplyBtn=document.getElementById('coverAdjustApply');
  const adjustCancelBtn=document.getElementById('coverAdjustCancel');
  const adjustResetBtn=document.getElementById('coverAdjustReset');
  let adjustState=null; // { zoom, panX, panY, dragging, lastX, lastY }
  function isAdjusting(){ return !!adjustState; }
  function refreshAdjustBtnVisibility(){
    if(!adjustBtn) return;
    // Mirror cover-remove-btn's visibility rule: visible whenever a cover is loaded.
    const hasCover=coverPreview.style.display==='block' && !!coverPreview.dataset.b64;
    adjustBtn.style.display=hasCover?'inline-flex':'none';
  }
  function applyTransform(){
    if(!adjustState) return;
    const { zoom, panX, panY } = adjustState;
    coverPreview.style.transform=`translate(${panX}px, ${panY}px) scale(${zoom})`;
  }
  function clampPan(){
    if(!adjustState) return;
    const tile=document.getElementById('tileCoverClick');
    if(!tile) return;
    const r=tile.getBoundingClientRect();
    const maxX=Math.max(0,(adjustState.zoom-1)*r.width/2);
    const maxY=Math.max(0,(adjustState.zoom-1)*r.height/2);
    if(adjustState.panX> maxX) adjustState.panX= maxX;
    if(adjustState.panX<-maxX) adjustState.panX=-maxX;
    if(adjustState.panY> maxY) adjustState.panY= maxY;
    if(adjustState.panY<-maxY) adjustState.panY=-maxY;
  }
  function onPointerDown(ev){
    if(!isAdjusting() || ev.button===2) return;
    if(adjustState.zoom<=1.0) return; // nothing to pan
    adjustState.dragging=true;
    adjustState.lastX=ev.clientX;
    adjustState.lastY=ev.clientY;
    try{ ev.target.setPointerCapture?.(ev.pointerId); }catch{}
    ev.preventDefault();
  }
  function onPointerMove(ev){
    if(!isAdjusting() || !adjustState.dragging) return;
    const dx=ev.clientX-adjustState.lastX;
    const dy=ev.clientY-adjustState.lastY;
    adjustState.lastX=ev.clientX;
    adjustState.lastY=ev.clientY;
    adjustState.panX+=dx;
    adjustState.panY+=dy;
    clampPan();
    applyTransform();
  }
  function onPointerUp(ev){
    if(!isAdjusting()) return;
    adjustState.dragging=false;
    try{ ev.target.releasePointerCapture?.(ev.pointerId); }catch{}
  }
  function bindPointerHandlers(){
    coverPreview.addEventListener('pointerdown', onPointerDown);
    coverPreview.addEventListener('pointermove', onPointerMove);
    coverPreview.addEventListener('pointerup', onPointerUp);
    coverPreview.addEventListener('pointercancel', onPointerUp);
    coverPreview.addEventListener('pointerleave', onPointerUp);
  }
  function unbindPointerHandlers(){
    coverPreview.removeEventListener('pointerdown', onPointerDown);
    coverPreview.removeEventListener('pointermove', onPointerMove);
    coverPreview.removeEventListener('pointerup', onPointerUp);
    coverPreview.removeEventListener('pointercancel', onPointerUp);
    coverPreview.removeEventListener('pointerleave', onPointerUp);
  }
  function enterAdjust(){
    if(isAdjusting()) return;
    if(!(coverPreview.style.display==='block' && coverPreview.dataset.b64)) return;
    const tile=document.getElementById('tileCoverClick');
    const r=tile?.getBoundingClientRect?.();
    const currentCrop=normalizeCoverCrop(coverPreview.dataset.crop);
    adjustState={
      zoom:currentCrop?.zoom || 1.0,
      panX:(currentCrop?.x || 0) * Math.max(1, r?.width || 1),
      panY:(currentCrop?.y || 0) * Math.max(1, r?.height || 1),
      dragging:false, lastX:0, lastY:0
    };
    const inner=document.querySelector('.modal-inner');
    if(inner) inner.classList.add('adjusting-cover');
    if(adjustControls) adjustControls.style.display='flex';
    if(adjustZoom) adjustZoom.value=String(Math.round(adjustState.zoom * 100));
    applyTransform();
    bindPointerHandlers();
  }
  function exitAdjust(){
    unbindPointerHandlers();
    adjustState=null;
    applyCoverCropToImage(coverPreview, coverPreview.dataset.crop);
    const inner=document.querySelector('.modal-inner');
    if(inner) inner.classList.remove('adjusting-cover');
    if(adjustControls) adjustControls.style.display='none';
  }
  async function applyAdjust(){
    if(!isAdjusting()) return;
    const tile=document.getElementById('tileCoverClick');
    if(!tile){ exitAdjust(); return; }
    const r=tile.getBoundingClientRect();
    const { zoom, panX, panY } = adjustState;
    try{
      // Disable controls briefly to avoid double-Apply.
      if(adjustApplyBtn) adjustApplyBtn.disabled=true;
      if(adjustCancelBtn) adjustCancelBtn.disabled=true;
      if(adjustResetBtn) adjustResetBtn.disabled=true;
      const crop=setPreviewCrop({
        zoom,
        x: panX / Math.max(1, r.width || 1),
        y: panY / Math.max(1, r.height || 1)
      });
      if(coverPreview.dataset._savedSrc === coverPreview.src){
        coverPreview.dataset._savedCrop = crop ? serializeCoverCrop(crop) : '';
      }
      markDirty();
      if(form.priorTxid.value && window.bookishApp?._autoSaveIfDirty){
        setTimeout(()=>{ try{ window.bookishApp._autoSaveIfDirty(); }catch{} }, 50);
      }
    }catch(err){
      console.warn('[Bookish:Adjust] Apply failed:', err?.message||err);
    }finally{
      if(adjustApplyBtn) adjustApplyBtn.disabled=false;
      if(adjustCancelBtn) adjustCancelBtn.disabled=false;
      if(adjustResetBtn) adjustResetBtn.disabled=false;
      exitAdjust();
      refreshAdjustBtnVisibility();
    }
  }
  function cancelAdjust(){
    if(!isAdjusting()) return;
    // Restore the original — coverPreview.src + dataset already match what we
    // captured (we never mutated them during a session), so just exit.
    exitAdjust();
    refreshAdjustBtnVisibility();
  }
  function resetAdjust(){
    if(!isAdjusting()) return;
    adjustState.zoom=1.0;
    adjustState.panX=0;
    adjustState.panY=0;
    if(adjustZoom) adjustZoom.value='100';
    applyTransform();
  }
  if(adjustBtn){
    adjustBtn.addEventListener('click',(e)=>{ e.stopPropagation(); enterAdjust(); });
  }
  if(adjustZoom){
    adjustZoom.addEventListener('input',()=>{
      if(!isAdjusting()) return;
      const pct=Math.max(100, Math.min(300, parseInt(adjustZoom.value,10)||100));
      adjustState.zoom=pct/100;
      // When zooming back to 1, force pan to 0 (per spec).
      if(adjustState.zoom<=1.0){ adjustState.panX=0; adjustState.panY=0; }
      else { clampPan(); }
      applyTransform();
    });
  }
  if(adjustApplyBtn){
    adjustApplyBtn.addEventListener('click',(e)=>{ e.stopPropagation(); applyAdjust(); });
  }
  if(adjustCancelBtn){
    adjustCancelBtn.addEventListener('click',(e)=>{ e.stopPropagation(); cancelAdjust(); });
  }
  if(adjustResetBtn){
    adjustResetBtn.addEventListener('click',(e)=>{ e.stopPropagation(); resetAdjust(); });
  }
  if(coverBrowseApplyBtn){
    coverBrowseApplyBtn.addEventListener('click',(e)=>{ e.stopPropagation(); applyCoverBrowseSelection(); });
  }
  if(coverBrowseCancelBtn){
    coverBrowseCancelBtn.addEventListener('click',(e)=>{ e.stopPropagation(); cancelCoverBrowseSelection(); });
  }
  // The cover-preview img sits inside #tileCoverClick which has a click handler
  // that opens the file picker. Block that while adjusting and also during a
  // drag, so a click that ends a drag doesn't accidentally trigger upload.
  if(tileCoverClick){
    tileCoverClick.addEventListener('click',(e)=>{
      if(isAdjusting()){ e.stopPropagation(); e.stopImmediatePropagation?.(); }
    }, true);
  }
  // Expose for external callers (e.g. app.js after upload/remove) to refresh
  // the Adjust button's visibility based on current cover state.
  window.__bookishRefreshAdjustBtn = refreshAdjustBtnVisibility;
  if(uploadCoverBtn && coverFileInput){
    uploadCoverBtn.addEventListener('click',(e)=>{ e.stopPropagation(); coverFileInput.click(); });
  }
  if(changeCoverLink){
    changeCoverLink.addEventListener('click',(e)=>{
      e.stopPropagation();
      const isOpen = coverActionsEl && coverActionsEl.style.display==='flex';
      if(coverActionsEl) coverActionsEl.style.display=isOpen?'none':'flex';
      changeCoverLink.setAttribute('aria-expanded', isOpen?'false':'true');
    });
  }

  /**
   * #114: Decoupled cover-edition browser entry point.
   * Invoked by the "Browse covers" button. Operates on the OL `work_key`
   * already attached to the entry (or captured from the omnibox at add time).
   * If no workKey, falls back to title/author search via findCoversForEntry().
   */
  async function browseCoversForEntry(workKey){
    if(isExistingBookEdit()) enterCoverBrowseMode();
    storeCurrentCoverSentinel();
    const title=(titleInput?.value||'').trim();
    const author=(authorInput?.value||'').trim();
    if(workKey){
      // Direct OL editions browsing path — no in-modal search needed.
      currentWorkKey = workKey;
      coverOnlyMode = true;
      itunesCoverState = null;
      editions = []; editionIndex = 0;
      if(findCoversBtn){ findCoversBtn.textContent='Searching…'; findCoversBtn.classList.add('loading'); findCoversBtn.style.display='block'; }
      try{
        await loadEditionsFromSearch({ key: workKey, title });
      } finally {
        if(findCoversBtn){ findCoversBtn.classList.remove('loading'); }
      }
      // loadEditionsFromSearch shows nav when editions arrive; hide pill if so.
      if(editions.length>1 && findCoversBtn) findCoversBtn.style.display='none';
      return;
    }
    // Fallback: legacy/manual entries with no work_key — find covers by metadata.
    findCoversForEntry(title, author);
  }

  window.bookSearch={
    /**
     * Called by app.js openModal (#114). Configures cover-action affordances
     * for the current entry. workKey is the OL work_key from the entry — used
     * to gate the "Browse covers" button (hidden for manual/legacy entries
     * with no work_key).
     */
    handleModalOpen(workKey){
      clearSearchState();
      currentWorkKey = workKey || '';
      hideCoverNav();
      // Always exit any leftover adjust state from a previous modal session.
      if(isAdjusting()) exitAdjust();
      refreshAdjustBtnVisibility();
      if(uploadCoverBtn) uploadCoverBtn.style.display='block';
      if(changeCoverLink){ changeCoverLink.style.display='block'; changeCoverLink.setAttribute('aria-expanded','false'); }
      if(coverActionsEl) coverActionsEl.style.display='none';
      if(findCoversBtn){
        if(workKey){
          const hasCover = coverPreview.style.display==='block' && coverPreview.dataset.b64;
          findCoversBtn.textContent = hasCover ? 'Browse other covers' : 'Browse covers';
          findCoversBtn.classList.remove('loading');
          findCoversBtn.style.display='block';
        } else {
          // No work_key on this entry — hide Browse covers entirely (#114).
          findCoversBtn.style.display='none';
        }
      }
    },
    handleModalClose(){ if(isAdjusting()) exitAdjust(); if(isCoverBrowsePending()) cancelCoverBrowseSelection(); clearSearchState(); },
    /** New decoupled entry point (#114). */
    browseCoversForEntry(workKey){ return browseCoversForEntry(workKey); },
    isCoverBrowsePending(){ return isCoverBrowsePending(); },
    /**
     * Used by the omnibox add-flow to feed a selected work into the modal
     * before openModal renders. Sets currentWorkKey + currentIsbn13 so the
     * form submit handler picks them up via getSearchMeta().
     */
    selectWork(meta){ selectWork(meta); },
    selectItunes(payload){ selectItunes(payload); },
    /**
     * Returns identifiers captured from the most recent search-result selection.
     * Consumed by the form submit handler in app.js to persist friend-matching keys.
     * Returns empty strings when the user hasn't picked a search result (e.g. manual entry).
     * @returns {{ work_key: string, isbn13: string }}
     */
    getSearchMeta(){ return { work_key: currentWorkKey || '', isbn13: currentIsbn13 || '' }; }
  };
})();
