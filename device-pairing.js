(function(){
  'use strict';

  var API='https://onay-device-sync.jjjjjjjjjjjjjjae.workers.dev';
  var DEVICE_KEY='onay-device-sync-device-id-v1';
  var LEDGER_KEY='onay-demo-trial-ledger-v1';
  var FAVORITES_KEY='onay-demo-favorite-routes';
  var AUTH_STORE_KEY='onay-virtual-child-accounts-demo-v1';
  var AUTH_LAST_PHONE_KEY='onay-demo-last-registered-phone-v1';
  var AUTH_PENDING_PHONE_KEY='onay-registration-pending-phone-v1';
  var RECEIVER_STATE_KEY='onay-device-sync-receiver-request-v1';
  var mode='', scannerStream=null, scannerTimer=null;
  var approvalPollTimer=null, approvalStatusTimer=null, receiverPollTimer=null, presenceTimer=null, autoPairBusy=false;
  var currentApproval=null, receiverRequestId='', receiverPhone='', seenRequests={};

  function $(id){return document.getElementById(id);}
  function parse(value){try{return value?JSON.parse(value):null;}catch(_){return null;}}
  function normalizePhone(value){return String(value||'').replace(/\D/g,'').slice(0,15);}
  function getDeviceId(){
    var id=localStorage.getItem(DEVICE_KEY);
    if(!id){
      id=crypto.randomUUID?crypto.randomUUID():String(Date.now())+'-'+String(crypto.getRandomValues(new Uint32Array(1))[0]);
      localStorage.setItem(DEVICE_KEY,id);
    }
    return id;
  }
  function accountPhone(){
    var account=window.__onayDemoAccount||{};
    var digits=normalizePhone(account.phoneDigits);
    return digits.length>=10?digits:'';
  }
  function currentPhone(){
    var digits=accountPhone();
    if(digits.length>=10)return digits;
    var fallback=String(getDeviceId()).replace(/\D/g,'').slice(-10);
    return ('7'+fallback.padStart(10,'0')).slice(0,15);
  }
  function ledgerKeyFor(phone){return LEDGER_KEY+':'+normalizePhone(phone);}
  function currentLedgerKey(){
    try{if(typeof trialLedgerStorageKey==='function')return trialLedgerStorageKey();}catch(_){}
    return ledgerKeyFor(currentPhone());
  }
  function b64(bytes){
    var text='';
    for(var i=0;i<bytes.length;i+=0x8000)text+=String.fromCharCode.apply(null,bytes.subarray(i,i+0x8000));
    return btoa(text);
  }
  function bytes(value){
    var text=atob(value),out=new Uint8Array(text.length);
    for(var i=0;i<text.length;i++)out[i]=text.charCodeAt(i);
    return out;
  }
  async function encryptionKey(code,salt){
    var material=await crypto.subtle.importKey('raw',new TextEncoder().encode(code),'PBKDF2',false,['deriveKey']);
    return crypto.subtle.deriveKey({name:'PBKDF2',salt:salt,iterations:120000,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
  }
  async function encrypt(value,code){
    var salt=crypto.getRandomValues(new Uint8Array(16));
    var iv=crypto.getRandomValues(new Uint8Array(12));
    var encrypted=await crypto.subtle.encrypt({name:'AES-GCM',iv:iv},await encryptionKey(code,salt),new TextEncoder().encode(JSON.stringify(value)));
    return {v:1,alg:'AES-GCM',salt:b64(salt),iv:b64(iv),ciphertext:b64(new Uint8Array(encrypted))};
  }
  async function decrypt(raw,code){
    var envelope=typeof raw==='string'?JSON.parse(raw):raw;
    var plain=await crypto.subtle.decrypt({name:'AES-GCM',iv:bytes(envelope.iv)},await encryptionKey(code,bytes(envelope.salt)),bytes(envelope.ciphertext));
    return JSON.parse(new TextDecoder().decode(plain));
  }
  async function request(path,body){
    var response=await fetch(API+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
    var result=await response.json().catch(function(){return {};});
    if(!response.ok||result.ok===false){
      var messages={
        invalid_phone:'Телефон нөмірі толық емес.',
        request_not_pending:'Бұл сұрау енді белсенді емес.',
        request_expired:'Растау уақыты өтіп кетті.',
        request_not_approved_or_expired:'Бірінші телефон әлі растаған жоқ немесе кодтың мерзімі өтті.',
        invalid_code:'8 таңбалы код қате.',
        code_already_claimed:'Бұл код бұрын қолданылған.',
        rate_limited:'Тым көп әрекет. Біраздан кейін қайталаңыз.',
        invalid_payload:'Синхрондау дерегі тым үлкен. Фото көлемі қысқартылып қайта көріңіз.'
      };
      throw new Error(messages[result.error]||result.error||'Серверге қосылу мүмкін болмады.');
    }
    return result;
  }
  function status(text,isError){
    var node=$('pair-status');
    if(node){node.textContent=text||'';node.style.color=isError?'#b42318':'';}
  }
  function setBusy(value){
    var button=$('pair-submit');
    if(button)button.disabled=!!value;
    var approve=$('pair-approve');
    if(approve)approve.disabled=!!value;
  }
  function payload(){
    var account=window.__onayDemoAccount||null;
    var accountCopy=null;
    try{accountCopy=account?JSON.parse(JSON.stringify(account)):null;}catch(_){accountCopy=null;}
    var ledger=parse(localStorage.getItem(currentLedgerKey()))||((typeof trialLedger!=='undefined')?trialLedger:null);
    var favorites=parse(localStorage.getItem(FAVORITES_KEY));
    return {
      version:2,
      createdAt:new Date().toISOString(),
      sourceDeviceId:getDeviceId(),
      data:{
        ledger:ledger||{version:1,balances:[],records:[],topups:[]},
        favorites:Array.isArray(favorites)?favorites:[],
        profile:{phoneDigits:accountPhone()||currentPhone(),displayName:accountCopy&&accountCopy.profile?accountCopy.profile.name||null:null},
        account:accountCopy
      }
    };
  }
  function saveReceiverState(){
    try{sessionStorage.setItem(RECEIVER_STATE_KEY,JSON.stringify({requestId:receiverRequestId,phone:receiverPhone}));}catch(_){}
  }
  function clearReceiverState(){
    try{sessionStorage.removeItem(RECEIVER_STATE_KEY);}catch(_){}
  }
  function resumeReceiverRequest(){
    if(accountPhone()||mode==='approval'||mode==='sender')return;
    var saved=parse(sessionStorage.getItem(RECEIVER_STATE_KEY));
    if(!saved||!saved.requestId||normalizePhone(saved.phone).length<10)return;
    receiverRequestId=String(saved.requestId);
    receiverPhone=normalizePhone(saved.phone);
    showReceiverWaiting({requestId:receiverRequestId});
  }

  function stopScanner(){
    if(scannerTimer){cancelAnimationFrame(scannerTimer);scannerTimer=null;}
    if(scannerStream){scannerStream.getTracks().forEach(function(track){track.stop();});scannerStream=null;}
    var video=$('pair-scanner-video');
    if(video){video.pause();video.srcObject=null;video.hidden=true;}
    var button=$('pair-scan');
    if(button)button.textContent='QR сканерін ашу';
  }
  function clearReceiverPolling(){
    if(receiverPollTimer){clearInterval(receiverPollTimer);receiverPollTimer=null;}
  }
  function clearApprovalStatusPolling(){
    if(approvalStatusTimer){clearInterval(approvalStatusTimer);approvalStatusTimer=null;}
  }
  function hideModal(){
    stopScanner();
    clearReceiverPolling();
    clearApprovalStatusPolling();
    var modal=$('pair-modal');
    if(modal)modal.hidden=true;
    mode='';
    currentApproval=null;
    receiverRequestId='';
    receiverPhone='';
    status('');
    setBusy(false);
  }
  function showModal(){var modal=$('pair-modal');if(modal){modal.hidden=false;modal.removeAttribute('hidden');modal.style.display='flex';modal.style.visibility='visible';modal.style.zIndex='99999';}}
  function hidePairParts(){
    ['pair-code','pair-qr','pair-scanner-video','pair-input','pair-scan','pair-submit','pair-approval-actions'].forEach(function(id){var node=$(id);if(node)node.hidden=true;});
  }
  function randomCode(){
    return String(crypto.getRandomValues(new Uint32Array(1))[0]%100000000).padStart(8,'0');
  }
  function codeLabel(code){return String(code||'').replace(/(\d{4})(\d{4})/,'$1 $2');}
  function qrUrl(value){
    return 'https://api.qrserver.com/v1/create-qr-code/?size=280x280&margin=8&data='+encodeURIComponent(value);
  }
  function parsePairToken(value){
    var text=String(value||'').trim();
    var requestMatch=text.match(/^ONAYPAIRREQ:([^:]+):(\d{8})$/i);
    if(requestMatch)return {requestId:requestMatch[1],code:requestMatch[2]};
    var codeMatch=text.match(/(?:ONAYPAIR[:\s-]*)?(\d{8})/i);
    return codeMatch?{requestId:'',code:codeMatch[1]}:null;
  }
  async function scanQr(){
    if(scannerStream){stopScanner();status('QR сканері тоқтатылды.');return;}
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      status('Камераға қолжетім жоқ. 8 таңбалы кодты енгізіңіз.',true);return;
    }
    var video=$('pair-scanner-video');
    try{
      try{if(window.OnayNative&&OnayNative.requestCameraPermission)OnayNative.requestCameraPermission();}catch(_){}
      scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      video.srcObject=scannerStream;video.hidden=false;await video.play();
      var button=$('pair-scan');if(button)button.textContent='QR сканерін тоқтату';
      var detector=null;
      if(typeof BarcodeDetector!=='undefined'){
        try{detector=new BarcodeDetector({formats:['qr_code']});}catch(_){}
      }
      if(!detector){status('Камера ашылды. QR автоматты оқылмаса, 8 таңбалы кодты енгізіңіз.');return;}
      var tick=async function(){
        if(!scannerStream)return;
        try{
          var codes=await detector.detect(video);
          var token=parsePairToken(codes&&codes[0]?codes[0].rawValue:'');
          if(token){
            if(token.requestId&&receiverRequestId&&token.requestId!==receiverRequestId){
              status('Бұл QR басқа сұрауға тиесілі.',true);
            }else{
              stopScanner();
              $('pair-input').value=token.code;
              status('QR код оқылды. «Деректерді алу» батырмасын басыңыз.');
            }
            return;
          }
        }catch(_){}
        scannerTimer=requestAnimationFrame(tick);
      };
      scannerTimer=requestAnimationFrame(tick);
    }catch(_){
      stopScanner();
      status('Камераны ашу мүмкін болмады. Рұқсатты тексеріңіз немесе кодты енгізіңіз.',true);
    }
  }
  function isApproverReady(){
    var gate=$('app-pin-gate');
    return !!accountPhone()&&!!window.__onayDemoAccount&&(!gate||gate.hidden===true);
  }
  async function pollPendingApproval(){
    if(!isApproverReady()||currentApproval||mode==='approval'||mode==='sender')return;
    try{
      var result=await request('/v1/pair/pending',{phone:accountPhone()});
      if(result.pending&&result.requestId&&!seenRequests[result.requestId]){
        seenRequests[result.requestId]=true;
        openApproval(result);
      }
    }catch(_){}
  }
  async function heartbeatPresence(){
    if(!isApproverReady())return;
    try{await request('/v1/pair/presence',{phone:accountPhone(),deviceId:getDeviceId()});}catch(_){}
  }
  function startApprovalPolling(){
    if(approvalPollTimer)return;
    approvalPollTimer=setInterval(pollPendingApproval,2500);
    presenceTimer=setInterval(heartbeatPresence,15000);
    pollPendingApproval();
    heartbeatPresence();
  }
  function openApproval(requestInfo){
    clearReceiverPolling();
    clearApprovalStatusPolling();
    currentApproval=requestInfo;
    mode='approval';
    $('pair-title').textContent='Жаңа телефон сұрауы';
    $('pair-text').textContent='Осы нөмірдің деректерін екінші телефонға көшіруге рұқсат бересіз бе? Бірінші телефон аккаунттан шықпайды.';
    hidePairParts();
    $('pair-approval-actions').hidden=false;
    $('pair-approve').onclick=approveCurrent;
    $('pair-reject').onclick=rejectCurrent;
    status('Екінші телефон осы нөмірді енгізді.');
    showModal();
  }
  async function rejectCurrent(){
    if(!currentApproval)return;
    setBusy(true);
    try{
      await request('/v1/pair/reject',{requestId:currentApproval.requestId,phone:accountPhone()});
      status('Сұрау қабылданбады.');
      setTimeout(hideModal,500);
    }catch(error){status(error.message,true);setBusy(false);}
  }
  async function approveCurrent(){
    if(!currentApproval)return;
    setBusy(true);
    try{
      var code=randomCode();
      var packageData=payload();
      var encryptedPayload=JSON.stringify(await encrypt(packageData,code));
      if(encryptedPayload.length>3900000&&packageData.data&&packageData.data.account&&packageData.data.account.profile){
        packageData.data.account.profile.photo=null;
        encryptedPayload=JSON.stringify(await encrypt(packageData,code));
      }
      if(encryptedPayload.length>3900000)throw new Error('Синхрондау дерегі тым үлкен. Фотоны кішірейтіп қайта көріңіз.');
      var result=await request('/v1/pair/approve',{
        requestId:currentApproval.requestId,
        phone:accountPhone(),
        pairCode:code,
        encryptedPayload:encryptedPayload
      });
      mode='sender';
      $('pair-approval-actions').hidden=true;
      $('pair-code').textContent=codeLabel(result.code||code);
      $('pair-code').hidden=false;
      $('pair-qr').src=qrUrl('ONAYPAIRREQ:'+currentApproval.requestId+':'+(result.code||code));
      $('pair-qr').hidden=false;
      $('pair-title').textContent='Дерек жіберуге дайын';
      $('pair-text').textContent='Алыста болса 8 таңбалы кодты, жақын болса QR-ды екінші телефонмен қолданыңыз. Бірінші телефон ашық күйінде қалады.';
      status('Код 10 минут жарамды.');
      setBusy(false);
      clearApprovalStatusPolling();
      approvalStatusTimer=setInterval(pollApprovedStatus,2000);
    }catch(error){status(error.message||'Растау сәтсіз аяқталды.',true);setBusy(false);}
  }
  async function pollApprovedStatus(){
    if(!currentApproval)return;
    try{
      var result=await request('/v1/pair/status',{requestId:currentApproval.requestId});
      if(result.status==='claimed'){
        clearApprovalStatusPolling();
        status('Екінші телефон деректерді қабылдады. Бірінші телефонда аккаунт ашық қалды.');
      }else if(result.status==='expired'||result.status==='rejected'){
        clearApprovalStatusPolling();
        status('Сұрау аяқталды.',true);
      }
    }catch(_){}
  }
  async function requestPairingFromAuth(phoneOverride){
    var input=$('auth-phone-input');
    var phone=normalizePhone(phoneOverride||input&&input.value);
    if(phone.length<10){
      var error=$('auth-error');
      if(error)error.textContent='Телефон нөмірін толық енгізіңіз.';
      if(input)input.focus();
      return;
    }
    var node=$('auth-error');
    if(node)node.textContent='';
    try{
      var result=await request('/v1/pair/request',{phone:phone,requesterDeviceId:getDeviceId()});
      receiverPhone=phone;
      receiverRequestId=result.requestId;
      saveReceiverState();
      showReceiverWaiting(result);
    }catch(error){
      if(node)node.textContent=error.message||'Сұрау жіберілмеді.';
    }
  }
  function showReceiverWaiting(result){
    stopScanner();
    clearApprovalStatusPolling();
    clearReceiverPolling();
    mode='requester';
    $('pair-title').textContent='Бірінші телефонды растау';
    $('pair-text').textContent='Нөміріңіз бірінші телефонда онлайн болса, сол телефонда растау батырмасы шығады.';
    hidePairParts();
    $('pair-input').hidden=false;
    $('pair-input').value='';
    $('pair-scan').hidden=false;
    $('pair-scan').onclick=scanQr;
    $('pair-submit').hidden=false;
    $('pair-submit').disabled=true;
    $('pair-submit').textContent='Растауды күту…';
    $('pair-submit').onclick=function(){status('Алдымен бірінші телефондағы растауды күтіңіз.');};
    status('Растауды күтіп тұр. Кодты енгізу немесе QR сканерлеу осы жерде қолжетімді.');
    showModal();
    var modal=$('pair-modal');if(modal)modal.setAttribute('aria-label','Код енгізу және QR сканерлеу беті');
    receiverPollTimer=setInterval(pollReceiverStatus,1800);
    pollReceiverStatus();
  }
  function showReceiverApproved(){
    clearReceiverPolling();
    mode='receiver';
    $('pair-title').textContent='Код немесе QR арқылы алу';
    $('pair-text').textContent='Бірінші телефон көрсеткен 8 таңбалы кодты енгізіңіз немесе QR-ды сканерлеңіз.';
    hidePairParts();
    $('pair-input').hidden=false;
    $('pair-scan').hidden=false;
    $('pair-scan').onclick=scanQr;
    $('pair-submit').hidden=false;
    $('pair-submit').disabled=false;
    $('pair-submit').textContent='Деректерді алу';
    $('pair-submit').onclick=claimRequestedPair;
    status('Бірінші телефон растады. Кодты енгізіңіз немесе QR сканерлеңіз.');
    showModal();
    var modal=$('pair-modal');if(modal)modal.setAttribute('aria-label','Код енгізу және QR сканерлеу беті');
    setTimeout(function(){if($('pair-input'))$('pair-input').focus();},60);
  }
  async function pollReceiverStatus(){
    if(!receiverRequestId)return;
    try{
      var result=await request('/v1/pair/status',{requestId:receiverRequestId});
      if(result.status==='approved')showReceiverApproved();
      else if(result.status==='rejected'||result.status==='expired'){
        clearReceiverPolling();
        clearReceiverState();
        status('Бірінші телефон сұрауды қабылдамады немесе уақыты өтті.',true);
      }
    }catch(error){
      if(error.message&&error.message.indexOf('табылмады')>=0)clearReceiverPolling();
    }
  }
  function saveImportedData(data){
    if(!data||!data.data||!data.data.ledger)throw new Error('Синхрондалатын дерек табылмады.');
    var sourceAccount=data.data.account;
    var targetPhone=normalizePhone(data.data.profile&&data.data.profile.phoneDigits||sourceAccount&&sourceAccount.phoneDigits||receiverPhone);
    if(targetPhone.length<10)throw new Error('Телефон дерегі табылмады.');
    if(sourceAccount&&sourceAccount.pinSalt&&sourceAccount.pinHash&&sourceAccount.profile){
      var accounts=parse(localStorage.getItem(AUTH_STORE_KEY))||{};
      accounts[targetPhone]=sourceAccount;
      localStorage.setItem(AUTH_STORE_KEY,JSON.stringify(accounts));
      localStorage.setItem(AUTH_LAST_PHONE_KEY,targetPhone);
      sessionStorage.setItem(AUTH_PENDING_PHONE_KEY,targetPhone);
    }
    localStorage.setItem(ledgerKeyFor(targetPhone),JSON.stringify(data.data.ledger));
    if(Array.isArray(data.data.favorites))localStorage.setItem(FAVORITES_KEY,JSON.stringify(data.data.favorites));
    localStorage.setItem('onay-device-sync-last-import-v1',JSON.stringify({importedAt:new Date().toISOString(),phone:targetPhone}));
  }
  async function claimRequestedPair(){
    var input=$('pair-input');
    var code=String(input&&input.value||'').replace(/\D/g,'');
    if(!/^\d{8}$/.test(code)){
      status('8 таңбалы кодты толық енгізіңіз.',true);
      if(input)input.focus();
      return;
    }
    setBusy(true);
    status('Деректер алынуда…');
    try{
      var result=await request('/v1/pair/claim-request',{requestId:receiverRequestId,code:code});
      var data=await decrypt(result.encryptedPayload,code);
      saveImportedData(data);
      clearReceiverState();
      status('Синхрондау аяқталды. Қосымша ашылады…');
      setTimeout(function(){location.reload();},700);
    }catch(error){
      status(error.message||'Код жарамсыз немесе мерзімі өткен.',true);
      setBusy(false);
    }
  }
  function patchAuthSubmitPhone(){
    if(typeof window.authSubmitPhone!=='function'||window.authSubmitPhone.__onayPairWrapper)return;
    var original=window.authSubmitPhone;
    var wrapper=function(){
      var callArgs=arguments;
      var input=$('auth-phone-input');
      var digits=normalizePhone(input&&input.value);
      if(digits.length!==10)return original.apply(this,callArgs);
      var accounts=parse(localStorage.getItem(AUTH_STORE_KEY))||{};
      var localAccount=accounts[digits];
      if(localAccount&&localAccount.pinHash&&localAccount.profile)return original.apply(this,callArgs);
      if(autoPairBusy)return;
      autoPairBusy=true;
      request('/v1/pair/availability',{phone:digits}).then(function(result){
        if(result.online)return requestPairingFromAuth(digits);
        return original.apply(this,callArgs);
      }.bind(this)).catch(function(){
        return original.apply(this,callArgs);
      }.bind(this)).finally(function(){autoPairBusy=false;});
    };
    wrapper.__onayPairWrapper=true;
    window.authSubmitPhone=wrapper;
  }
  function install(){
    if(!$('pair-modal')){
      var style=document.createElement('style');
      style.textContent='.pair-auth-action{display:block;width:100%;min-height:44px;margin:10px 0 0;border:1px solid #e4b400;border-radius:999px;background:#fff7d6;color:#11152d;font-size:13px;font-weight:700}.pair-auth-action:disabled{opacity:.55}.pair-auth-note{margin:8px 0 0;color:#737887;font-size:11px;line-height:1.4;text-align:center}.pair-modal{position:absolute;inset:0;z-index:2000;display:flex;align-items:flex-end;justify-content:center;padding:12px;background:rgba(18,20,28,.38)}.pair-modal[hidden]{display:none!important}.pair-dialog{width:min(100%,420px);padding:22px 18px calc(18px + env(safe-area-inset-bottom));border-radius:24px;background:#fff;box-shadow:0 16px 50px rgba(0,0,0,.22)}.pair-dialog h3{margin:0 0 8px;color:#11152d;font-size:17px}.pair-dialog p{margin:0 0 12px;color:#626675;font-size:12px;line-height:1.45}.pair-close{float:right;width:30px;height:30px;border:0;border-radius:50%;background:#f0f1f7;font-size:20px}.pair-code{margin:16px 0 12px;padding:12px;border-radius:14px;background:#fff7d6;color:#171717;font-size:30px;font-weight:800;letter-spacing:4px;text-align:center}.pair-input{box-sizing:border-box;width:100%;height:48px;margin:8px 0 12px;border:1px solid #d9dce7;border-radius:13px;font-size:22px;letter-spacing:5px;text-align:center}.pair-submit{width:100%;height:46px;border:0;border-radius:999px;background:#ffbf00;font-size:13px;font-weight:700}.pair-submit:disabled{opacity:.55}.pair-qr{display:block;width:220px;height:220px;margin:12px auto;border-radius:12px;background:#fff}.pair-scan{width:100%;height:42px;margin:0 0 10px;border:1px solid #d9dce7;border-radius:12px;background:#f7f8fc;color:#11152d;font-size:12px;font-weight:700}.pair-scanner-video{display:block;width:100%;max-height:220px;margin:8px 0;border-radius:14px;background:#10131c;object-fit:cover}.pair-approval-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}.pair-approval-actions button{height:44px;border:0;border-radius:999px;font-size:13px;font-weight:700}.pair-approve{background:#ffbf00;color:#11152d}.pair-reject{background:#f0f1f7;color:#11152d}.pair-status{min-height:18px;text-align:center}';
      document.head.appendChild(style);
      var root=$('onay-app-root')||document.body;
      root.insertAdjacentHTML('beforeend','<div class="pair-modal" hidden id="pair-modal" onclick="if(event.target===this)closeDevicePairModal()"><div class="pair-dialog" role="dialog" aria-modal="true"><button class="pair-close" type="button" onclick="closeDevicePairModal()">×</button><h3 id="pair-title">Телефонды синхрондау</h3><p id="pair-text"></p><div class="pair-approval-actions" hidden id="pair-approval-actions"><button class="pair-approve" id="pair-approve" type="button">Растау</button><button class="pair-reject" id="pair-reject" type="button">Бас тарту</button></div><div class="pair-code" hidden id="pair-code"></div><img class="pair-qr" hidden id="pair-qr" alt="ONAY синхрондау QR коды"/><video class="pair-scanner-video" hidden id="pair-scanner-video" playsinline muted></video><input class="pair-input" hidden id="pair-input" maxlength="8" inputmode="numeric" type="tel" placeholder="00000000"/><button class="pair-scan" hidden id="pair-scan" type="button">QR сканерін ашу</button><button class="pair-submit" hidden id="pair-submit" type="button">Деректерді алу</button><p class="pair-status" id="pair-status" aria-live="polite"></p></div></div>');
    }
    var authContent=$('auth-content');
    if(authContent){
      var observer=new MutationObserver(function(){patchAuthSubmitPhone();resumeReceiverRequest();});
      observer.observe(authContent,{childList:true,subtree:true});
      patchAuthSubmitPhone();
      resumeReceiverRequest();
    }
    startApprovalPolling();
  }
  window.closeDevicePairModal=hideModal;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();