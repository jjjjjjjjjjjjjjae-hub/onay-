(function(){
  'use strict';
  const API='https://onay-device-sync.jjjjjjjjjjjjjjae.workers.dev';
  const DEVICE_KEY='onay-device-sync-device-id-v1';
  const LEDGER_KEY='onay-demo-trial-ledger-v1';
  const FAVORITES_KEY='onay-demo-favorite-routes';
  let mode='',scannerStream=null,scannerTimer=null;

  const $=id=>document.getElementById(id);
  const parse=value=>{try{return value?JSON.parse(value):null;}catch(_){return null;}};
  function getDeviceId(){
    let id=localStorage.getItem(DEVICE_KEY);
    if(!id){id=crypto.randomUUID?crypto.randomUUID():`${Date.now()}-${Math.random()}`;localStorage.setItem(DEVICE_KEY,id);}
    return id;
  }
  function phone(){
    const account=window.__onayDemoAccount||{};
    const current=String(account.phoneDigits||((typeof activeTrialPhoneDigits!=='undefined')?activeTrialPhoneDigits:'')).replace(/\D/g,'');
    if(current.length>=10)return current;
    return (`7${getDeviceId().replace(/\D/g,'').slice(-10).padStart(10,'0')}`).slice(0,15);
  }
  function ledgerKey(){
    try{if(typeof trialLedgerStorageKey==='function')return trialLedgerStorageKey();}catch(_){}
    return `${LEDGER_KEY}:${phone()}`;
  }
  function b64(bytes){
    let text='';
    for(let i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode(...bytes.subarray(i,i+0x8000));
    return btoa(text);
  }
  function bytes(value){
    const text=atob(value),out=new Uint8Array(text.length);
    for(let i=0;i<text.length;i++)out[i]=text.charCodeAt(i);
    return out;
  }
  async function key(code,salt){
    const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(code),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:120000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function encrypt(value,code){
    const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
    const encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv},await key(code,salt),new TextEncoder().encode(JSON.stringify(value)));
    return {v:1,alg:'AES-GCM',salt:b64(salt),iv:b64(iv),ciphertext:b64(new Uint8Array(encrypted))};
  }
  async function decrypt(raw,code){
    const envelope=typeof raw==='string'?JSON.parse(raw):raw;
    const plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv)},await key(code,bytes(envelope.salt)),bytes(envelope.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function request(path,body){
    const response=await fetch(`${API}${path}`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    const result=await response.json().catch(()=>({}));
    if(!response.ok||result.ok===false)throw new Error(result.error||'Серверге қосылу мүмкін болмады');
    return result;
  }
  function status(value,error){const node=$('pair-status');if(node){node.textContent=value;node.style.color=error?'#b42318':'';}}
  function busy(value){const button=$('pair-submit');if(button)button.disabled=value;}
  function payload(){
    const account=window.__onayDemoAccount||{};
    const ledger=parse(localStorage.getItem(ledgerKey()))||((typeof trialLedger!=='undefined')?trialLedger:null);
    const favorites=parse(localStorage.getItem(FAVORITES_KEY));
    return {version:1,createdAt:new Date().toISOString(),sourceDeviceId:getDeviceId(),data:{
      ledger:ledger||{version:1,balances:[],records:[],topups:[]},
      favorites:Array.isArray(favorites)?favorites:[],
      profile:{phoneDigits:phone(),displayName:account.displayName||account.name||null}
    }};
  }
  function show(){ $('pair-modal').hidden=false; }
  function stopScanner(){
    if(scannerTimer){cancelAnimationFrame(scannerTimer);scannerTimer=null;}
    if(scannerStream){scannerStream.getTracks().forEach(track=>track.stop());scannerStream=null;}
    const video=$('pair-scanner-video');
    if(video){video.pause();video.srcObject=null;video.hidden=true;}
    const button=$('pair-scan');
    if(button){button.textContent='QR сканерін ашу';}
  }
  function hide(){stopScanner();$('pair-modal').hidden=true;mode='';status('');busy(false);}
  function parsePairCode(value){
    const match=String(value||'').match(/(?:ONAYPAIR[:\\s-]*)?(\\d{8})/i);
    return match?match[1]:'';
  }
  async function scanQr(){
    if(scannerStream){stopScanner();status('QR сканері тоқтатылды.');return;}
    if(typeof BarcodeDetector==='undefined'||!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      status('QR сканері қолжетімсіз. 8 таңбалы кодты енгізіңіз.',true);return;
    }
    const video=$('pair-scanner-video');
    try{
      const detector=new BarcodeDetector({formats:['qr_code']});
      scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      video.srcObject=scannerStream;video.hidden=false;await video.play();
      const button=$('pair-scan');if(button)button.textContent='QR сканерін тоқтату';
      const tick=async()=>{
        if(!scannerStream)return;
        try{
          const codes=await detector.detect(video);
          const code=parsePairCode(codes&&codes[0]?codes[0].rawValue:'');
          if(code){
            stopScanner();
            $('pair-input').value=code;
            status('QR код оқылды. Енді «Деректерді алу» батырмасын басыңыз.');
            return;
          }
        }catch(_){}
        scannerTimer=requestAnimationFrame(tick);
      };
      scannerTimer=requestAnimationFrame(tick);
    }catch(error){
      stopScanner();
      status('QR камерасын ашу мүмкін болмады. 8 таңбалы кодты енгізіңіз.',true);
    }
  }
  function openSender(){
    stopScanner();mode='sender';$('pair-title').textContent='1-телефоннан беру';$('pair-text').textContent='QR немесе 8 таңбалы код көрсетіледі. Деректер шифрланады.'; 
    $('pair-code').hidden=true;$('pair-qr').hidden=true;$('pair-scanner-video').hidden=true;$('pair-scan').hidden=true;$('pair-input').hidden=true;$('pair-submit').textContent='Кодты жасау';$('pair-submit').onclick=createPair;status('');show();
  }
  function openReceiver(){
    stopScanner();mode='receiver';$('pair-title').textContent='2-телефоннан алу';$('pair-text').textContent='QR сканерлеңіз немесе 1-телефондағы 8 таңбалы кодты енгізіңіз.';
    $('pair-code').hidden=true;$('pair-qr').hidden=true;const input=$('pair-input');input.hidden=false;input.value='';$('pair-scanner-video').hidden=true;const scan=$('pair-scan');scan.hidden=false;scan.onclick=scanQr;$('pair-submit').textContent='Деректерді алу';$('pair-submit').onclick=claimPair;status('');show();setTimeout(()=>input.focus(),50);
  }
  async function createPair(){
    busy(true);status('Деректер дайындалуда…');
    try{
      const code=String(crypto.getRandomValues(new Uint32Array(1))[0]%100000000).padStart(8,'0');
      const result=await request('/v1/pair/create',{phone:phone(),pairCode:code,encryptedPayload:JSON.stringify(await encrypt(payload(),code))});
      const shownCode=String(result.code||code).replace(/\\D/g,'');
      $('pair-code').textContent=shownCode.replace(/(\\d{4})(\\d{4})/,'$1 $2');$('pair-code').hidden=false;$('pair-input').hidden=true;$('pair-scan').hidden=true;
      const qr=$('pair-qr');qr.src='https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=8&data='+encodeURIComponent('ONAYPAIR:'+shownCode);qr.hidden=false;
      $('pair-text').textContent='2-телефон QR-ды сканерлейді немесе осы 8 таңбалы кодты енгізеді.';$('pair-submit').textContent='Жабу';$('pair-submit').onclick=hide;
      status('Код 10 минут жарамды.'); 
    }catch(error){status(error.message||'Синхрондау сәтсіз аяқталды.',true);}
    finally{busy(false);}
  }
  async function claimPair(){
    const input=$('pair-input'),code=String(input.value||'').replace(/\D/g,'');
    if(!/^\d{8}$/.test(code)){status('8 таңбалы кодты толық енгізіңіз.',true);input.focus();return;}
    busy(true);status('Деректер алынуда…');
    try{
      const result=await request('/v1/pair/claim',{code}),data=await decrypt(result.encryptedPayload,code);
      if(!data.data||!data.data.ledger)throw new Error('Синхрондалатын дерек табылмады');
      localStorage.setItem(ledgerKey(),JSON.stringify(data.data.ledger));
      if(Array.isArray(data.data.favorites))localStorage.setItem(FAVORITES_KEY,JSON.stringify(data.data.favorites));
      localStorage.setItem('onay-device-sync-last-import-v1',JSON.stringify({importedAt:new Date().toISOString()}));
      status('Синхрондау аяқталды. Қосымша жаңартылады.');setTimeout(()=>location.reload(),700);
    }catch(error){status(error.message||'Код жарамсыз немесе мерзімі өткен.',true);busy(false);}
  }
  function install(){
    if(!$('page-family')||$('pair-modal'))return;
    const style=document.createElement('style');style.textContent=`
      .pair-box{margin-top:10px;padding:12px;border-radius:18px;background:#fff;box-shadow:0 4px 18px rgba(17,21,45,.06)}
      .pair-box p{margin:0 0 9px!important;color:#11152d!important;font-size:12px!important;font-weight:700!important}
      .pair-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px}.pair-actions button{min-height:38px;border:1px solid #e3e5ee;border-radius:12px;background:#f7f8fc;color:#11152d;font-size:11px;font-weight:600}.pair-actions button:first-child{border-color:#ffbf00;background:#ffbf00}
      .pair-modal{position:absolute;inset:0;z-index:20;display:flex;align-items:flex-end;justify-content:center;padding:12px;background:rgba(18,20,28,.38)}.pair-modal[hidden]{display:none!important}.pair-dialog{width:min(100%,420px);padding:22px 18px calc(18px + env(safe-area-inset-bottom));border-radius:24px;background:#fff;box-shadow:0 16px 50px rgba(0,0,0,.22)}.pair-dialog h3{margin:0 0 8px;color:#11152d;font-size:17px}.pair-dialog p{margin:0 0 12px;color:#626675;font-size:12px;line-height:1.45}.pair-close{float:right;width:30px;height:30px;border:0;border-radius:50%;background:#f0f1f7;font-size:20px}.pair-code{margin:16px 0 12px;padding:12px;border-radius:14px;background:#fff7d6;color:#171717;font-size:30px;font-weight:800;letter-spacing:4px;text-align:center}.pair-input{box-sizing:border-box;width:100%;height:48px;margin:8px 0 12px;border:1px solid #d9dce7;border-radius:13px;font-size:22px;letter-spacing:5px;text-align:center}.pair-submit{width:100%;height:46px;border:0;border-radius:999px;background:#ffbf00;font-size:13px;font-weight:700}.pair-submit:disabled{opacity:.55}.pair-qr{display:block;width:220px;height:220px;margin:12px auto;border-radius:12px;background:#fff}.pair-scan{width:100%;height:42px;margin:0 0 10px;border:1px solid #d9dce7;border-radius:12px;background:#f7f8fc;color:#11152d;font-size:12px;font-weight:700}.pair-scanner-video{display:block;width:100%;max-height:220px;margin:8px 0;border-radius:14px;background:#10131c;object-fit:cover}.pair-status{min-height:18px;text-align:center}
    `;document.head.appendChild(style);
    const footer=document.querySelector('#page-family .family-footer');if(footer)footer.insertAdjacentHTML('beforeend','<div class="pair-box"><p>Телефондар арасында деректі синхрондау</p><div class="pair-actions"><button type="button" onclick="openDevicePairSender()">1-телефоннан беру</button><button type="button" onclick="openDevicePairReceiver()">2-телефоннан алу</button></div></div>');
    const family=$('page-family');family.insertAdjacentHTML('beforeend','<div class="pair-modal" hidden id="pair-modal" onclick="if(event.target===this)closeDevicePairModal()"><div class="pair-dialog" role="dialog" aria-modal="true"><button class="pair-close" type="button" onclick="closeDevicePairModal()">×</button><h3 id="pair-title">Телефонды синхрондау</h3><p id="pair-text"></p><div class="pair-code" hidden id="pair-code"></div><img class="pair-qr" hidden id="pair-qr" alt="ONAY синхрондау QR коды"/><video class="pair-scanner-video" hidden id="pair-scanner-video" playsinline muted></video><input class="pair-input" hidden id="pair-input" maxlength="8" inputmode="numeric" type="tel" placeholder="00000000"/><button class="pair-scan" hidden id="pair-scan" type="button">QR сканерін ашу</button><button class="pair-submit" id="pair-submit" type="button">Деректерді алу</button><p class="pair-status" id="pair-status" aria-live="polite"></p></div></div>');
  }
  window.openDevicePairSender=openSender;window.openDevicePairReceiver=openReceiver;window.closeDevicePairModal=hide;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();

