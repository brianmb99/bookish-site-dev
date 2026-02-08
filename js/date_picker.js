// Date picker polyfill & helper extracted
(function(){
  const input = document.querySelector('input[name=dateRead]');
  const btn = document.getElementById('openCalendarBtn');
  if(!input || !btn) return;
  const test = document.createElement('input'); test.type='date'; const native = (test.type === 'date');
  function focusNative(){ input.showPicker ? input.showPicker() : input.focus(); }
  btn.addEventListener('click', e => { if(native){ focusNative(); } else { togglePicker(); } });
  if(native){ return; }
  let picker; let visible=false; let current=new Date();
  function build(){
    if(!picker){ picker = document.createElement('div'); picker.id='datePicker'; picker.className='date-picker'; document.body.appendChild(picker); }
    const year=current.getFullYear(); const month=current.getMonth();
    const first=new Date(year,month,1); const startDay=first.getDay();
    const daysInMonth = new Date(year, month + 1, 0).getDate();
    const prevDays = new Date(year, month, 0).getDate();
    const today=new Date(); const sel = input.value ? new Date(input.value) : null;
    let html='<header><button type="button" id="dpPrev">‹</button><div>'+year+'-'+String(month+1).padStart(2,'0')+'</div><button type="button" id="dpNext">›</button></header><table><thead><tr>'; ['Su','Mo','Tu','We','Th','Fr','Sa'].forEach(d=> html+='<th>'+d+'</th>'); html+='</tr></thead><tbody><tr>';
    let dayCellCount=0;
    for(let i=0;i<startDay;i++){ const d = prevDays-startDay+i+1; html+='<td class="off">'+d+'</td>'; dayCellCount++; }
    for(let d=1; d<=daysInMonth; d++){ if(dayCellCount && dayCellCount%7===0) html+='</tr><tr>'; const dateObj=new Date(year,month,d);
      const isToday = dateObj.toDateString()===today.toDateString();
      const isSel = sel && dateObj.toDateString()===sel.toDateString();
      html+='<td data-day="'+d+'" class="'+(isToday?'today ':'')+(isSel?'selected':'')+'">'+d+'</td>'; dayCellCount++; }
    while(dayCellCount%7){ html+='<td class="off">&nbsp;</td>'; dayCellCount++; }
    html+='</tr></tbody></table>';
    picker.innerHTML = html;
    const rect = input.getBoundingClientRect();
    picker.style.left = (rect.left + window.scrollX)+'px';
    picker.style.top = (rect.bottom + window.scrollY + 4)+'px';
    picker.querySelector('#dpPrev').onclick = ()=>{ current.setMonth(current.getMonth()-1); build(); };
    picker.querySelector('#dpNext').onclick = ()=>{ current.setMonth(current.getMonth()+1); build(); };
    picker.querySelectorAll('td[data-day]').forEach(td=> td.onclick = ()=>{ const day = parseInt(td.dataset.day,10); const m=month+1; input.value = year+'-'+String(m).padStart(2,'0')+'-'+String(day).padStart(2,'0'); hide(); input.dispatchEvent(new Event('change', { bubbles:true })); });
  }
  function show(){ build(); picker.style.display='block'; visible=true; document.addEventListener('mousedown', outside); }
  function hide(){ if(picker){ picker.style.display='none'; } visible=false; document.removeEventListener('mousedown', outside); }
  function togglePicker(){ visible?hide():show(); }
  function outside(ev){ if(!picker.contains(ev.target) && ev.target!==input && ev.target!==btn) hide(); }
})();
