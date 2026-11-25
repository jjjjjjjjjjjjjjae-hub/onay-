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
  var mode='', scannerStream=null, scannerTimer=null, scannerOpening=false;
  var approvalPollTimer=null, approvalStatusTimer=null, receiverPollTimer=null, presenceTimer=null, autoPairBusy=false, authHookRetryTimer=null;
  var pairRequestInFlight=false, approvalActionInFlight=false, claimInFlight=false;
  var registeredServerPhone='', presenceInFlight=false, remoteLoginPhone='', remoteLoginBusy=false;
  var currentApproval=null, receiverRequestId='', receiverPhone='', seenRequests={};

  function $(id){return document.getElementById(id);}
  function parse(value){try{return value?JSON.parse(value):null;}catch(_){return null;}}
  function normalizePhone(value){
    var digits=String(value||'').replace(/\D/g,'');
    // Kazakhstan numbers may be entered as +7XXXXXXXXXX or 8XXXXXXXXXX.
    // Pairing and local account storage use the same ten-digit form.
    if(digits.length===11&&(digits.charAt(0)==='7'||digits.charAt(0)==='8'))digits=digits.slice(1);
    return digits.slice(0,15);
  }
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
        request_stale:'Бұл растау ескірді. Жаңа сұрау жіберіңіз.',
        invalid_code:'8 таңбалы код қате.',
        code_already_claimed:'Бұл код бұрын қолданылған.',
        rate_limited:'Тым көп әрекет. Біраздан кейін қайталаңыз.',
        invalid_device:'Құрылғы анықталмады. Қолданбаны қайта ашыңыз.',
        invalid_payload:'Синхрондау дерегі тым үлкен. Фото көлемі қысқартылып қайта көріңіз.',
        invalid_login:'Кіру деректері қате.',
        invalid_pin:'PIN-код қате. Қайта енгізіңіз.',
        account_not_synced:'Аккаунт серверге әлі сақталмаған. Ескі телефоннан бір рет PIN арқылы кіріп көріңіз.',
        account_snapshot_invalid:'Аккаунт деректерін қалпына келтіру мүмкін болмады.',
        invalid_account_snapshot:'Аккаунт деректері тым үлкен немесе толық емес.',
        phone_not_registered:'Бұл нөмір серверде тіркелмеген.',
        owner_offline:'Нөмір иесі желіде емес. Кейін қайталаңыз.',
        device_not_owner:'Бұл құрылғы осы нөмірдің негізгі телефоны емес.',
        account_transfer_failed:'Аккаунтты жаңа телефонға ауыстыру мүмкін болмады.',
        invalid_registration:'Тіркеу деректері толық емес.'
      };
      var error=new Error(messages[result.error]||result.error||'Серверге қосылу мүмкін болмады.');
      error.code=result.error||'';
      throw error;
    }
    return result;
  }
  function status(text,isError){
    var node=$('pair-status');
    if(node){node.textContent=text||'';node.style.color=isError?'#b42318':'';}
  }
  function pairingPageOpen(){return window.onayQrPairingMode===true&&$('page-qr')&&!$('page-qr').classList.contains('hidden');}
  function pairingStatus(text,isError){
    if(pairingPageOpen()){
      if(typeof window.showToast==='function')window.showToast(text||'');
      return;
    }
    status(text,isError);
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
  function localAccountForPhone(phone){
    var digits=normalizePhone(phone);
    if(digits.length<10)return null;
    var accounts=parse(localStorage.getItem(AUTH_STORE_KEY))||{};
    var account=accounts[digits]||null;
    try{return account?JSON.parse(JSON.stringify(account)):null;}catch(_){return null;}
  }
  function snapshotPayload(phone){
    var data=payload().data;
    var account=data.account||localAccountForPhone(phone);
    var digits=normalizePhone(phone||account&&account.phoneDigits);
    if(account&&digits.length>=10)data.profile={phoneDigits:digits,displayName:account.profile&&account.profile.name||null};
    data.account=account;
    return data;
  }
  async function syncAccountSnapshot(){
    var phone=accountPhone();
    if(phone.length<10||!window.__onayDemoAccount)return false;
    try{
      var data=snapshotPayload(phone);
      await request('/v1/account/snapshot',{phone:phone,deviceId:getDeviceId(),account:data.account,ledger:data.ledger,favorites:data.favorites});
      return true;
    }catch(_){return false;}
  }
  window.onaySyncAccountSnapshot=syncAccountSnapshot;
  function saveReceiverState(){
    try{sessionStorage.setItem(RECEIVER_STATE_KEY,JSON.stringify({requestId:receiverRequestId,phone:receiverPhone}));}catch(_){}
  }
  function clearReceiverState(){
    try{sessionStorage.removeItem(RECEIVER_STATE_KEY);}catch(_){}
  }
  function resumeReceiverRequest(){
    if(accountPhone()||mode==='approval'||mode==='sender'||mode==='requester'||mode==='receiver'||mode==='registered-offline')return;
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
    if(approvalActionInFlight)return;
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
    ['pair-code','pair-qr','pair-scanner-video','pair-open-code','pair-input','pair-scan','pair-submit','pair-approval-actions'].forEach(function(id){var node=$(id);if(node)node.hidden=true;});
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
  function handlePairQrValue(value){
    var token=parsePairToken(value);
    if(!token)return false;
    if(token.requestId&&receiverRequestId&&token.requestId!==receiverRequestId){
      pairingStatus('Бұл QR басқа сұрауға тиесілі.',true);
      return false;
    }
    stopScanner();
    if(typeof window.stopQrCamera==='function')window.stopQrCamera();
    if(token.requestId&&!receiverRequestId){
      receiverRequestId=token.requestId;
      saveReceiverState();
    }
    if(pairingPageOpen()){
      var qrInput=$('qr-manual-input');
      if(qrInput)qrInput.value=token.code;
      pairingStatus('QR код оқылды. Деректер алынуда…');
      claimRequestedPair(token.code);
      return true;
    }
    if(mode==='receiver')openReceiverCodeEntry();
    var input=$('pair-input');
    if(input)input.value=token.code;
    status('QR код оқылды. «Деректерді алу» батырмасын басыңыз.');
    return true;
  }
  window.onayPairingQrValue=function(value){
    if(!pairingPageOpen())return false;
    var token=parsePairToken(value);
    if(!token){
      pairingStatus('Бұл QR синхрондау коды емес.',true);
      return false;
    }
    return handlePairQrValue(value);
  };
  window.onayPairingManualSubmit=function(value){
    if(!pairingPageOpen()||mode!=='receiver')return false;
    var code=String(value||'').replace(/\D/g,'');
    if(!/^\d{8}$/.test(code)){
      pairingStatus('8 таңбалы кодты толық енгізіңіз.',true);
      return false;
    }
    claimRequestedPair(code);
    return true;
  };
  async function scanQr(){
    if(scannerStream){stopScanner();status('QR сканері тоқтатылды.');return;}
    if(scannerOpening)return;
    if(!navigator.mediaDevices||!navigator.mediaDevices.getUserMedia){
      status('Камераға қолжетім жоқ. 8 таңбалы кодты енгізіңіз.',true);return;
    }
    var video=$('pair-scanner-video');
    if(!video){
      status('QR сканері дайын емес. Терезені қайта ашыңыз.',true);return;
    }
    scannerOpening=true;
    showModal();
    video.autoplay=true;
    video.muted=true;
    video.setAttribute('playsinline','');
    video.setAttribute('webkit-playsinline','');
    video.hidden=false;
    try{
      try{
        if(window.OnayNative&&OnayNative.requestCameraPermission){
          OnayNative.requestCameraPermission();
          await new Promise(function(resolve){setTimeout(resolve,150);});
        }
      }catch(_){}
      scannerStream=await navigator.mediaDevices.getUserMedia({video:{facingMode:{ideal:'environment'}},audio:false});
      video.srcObject=scannerStream;
      await video.play();
      var button=$('pair-scan');if(button)button.textContent='QR сканерін тоқтату';
      var detector=null, fallbackCanvas=document.createElement('canvas'), fallbackContext=fallbackCanvas.getContext('2d',{willReadFrequently:true}), lastDecodeAt=0;
      if(typeof BarcodeDetector!=='undefined'){
        try{detector=new BarcodeDetector({formats:['qr_code']});}catch(_){}
      }
      if(!detector&&!window.jsQR){
        status('Камера ашылды. QR автоматты оқылмаса, 8 таңбалы кодты енгізіңіз.');
        return;
      }
      var tick=async function(){
        if(!scannerStream)return;
        try{
          if(Date.now()-lastDecodeAt>=180){
            lastDecodeAt=Date.now();
            var rawValue='';
            if(detector){
              var codes=await detector.detect(video);
              rawValue=codes&&codes[0]?codes[0].rawValue:'';
            }else if(fallbackContext&&video.readyState>=2&&video.videoWidth&&video.videoHeight){
              var width=Math.min(video.videoWidth,960),height=Math.max(1,Math.round(video.videoHeight*width/video.videoWidth));
              if(fallbackCanvas.width!==width||fallbackCanvas.height!==height){fallbackCanvas.width=width;fallbackCanvas.height=height;}
              fallbackContext.drawImage(video,0,0,width,height);
              var imageData=fallbackContext.getImageData(0,0,width,height);
              var decoded=window.jsQR(imageData.data,width,height,{inversionAttempts:'attemptBoth'});
              rawValue=decoded&&decoded.data||'';
            }
            if(handlePairQrValue(rawValue))return;
          }
        }catch(_){}
        if(scannerStream)scannerTimer=requestAnimationFrame(tick);
      };
      scannerTimer=requestAnimationFrame(tick);
    }catch(_){
      stopScanner();
      status('Камераны ашу мүмкін болмады. Рұқсатты тексеріңіз немесе кодты енгізіңіз.',true);
    }finally{
      scannerOpening=false;
    }
  }
  function isApproverReady(){
    var gate=$('app-pin-gate');
    return !!accountPhone()&&!!window.__onayDemoAccount&&(!gate||gate.hidden===true);
  }
  async function pollPendingApproval(){
    if(!isApproverReady()||currentApproval||mode==='approval'||mode==='sender')return;
    try{
      var result=await request('/v1/pair/pending',{phone:accountPhone(),deviceId:getDeviceId()});
      if(result.pending&&result.requestId&&!seenRequests[result.requestId]){
        seenRequests[result.requestId]=true;
        openApproval(result);
      }
    }catch(_){}
  }
  async function registerPhoneOnServer(phoneOverride){
    var phone=normalizePhone(phoneOverride||accountPhone());
    if(phone.length<10)return false;
    if(registeredServerPhone===phone)return true;
    try{
      var data=snapshotPayload(phone);
      var body={phone:phone,deviceId:getDeviceId()};
      if(data.account){body.account=data.account;body.ledger=data.ledger;body.favorites=data.favorites;}
      var result=await request('/v1/account/register',body);
      if(result.owner===false){
        var ownerError=new Error('Бұл құрылғы осы нөмірдің негізгі телефоны емес.');
        ownerError.code='device_not_owner';
        throw ownerError;
      }
      registeredServerPhone=phone;
      return true;
    }catch(error){
      if(error&&error.code==='device_not_owner')throw error;
      return false;
    }
  }
  async function heartbeatPresence(){
    if(!isApproverReady()||presenceInFlight)return;
    var phone=accountPhone();
    if(phone.length<10)return;
    presenceInFlight=true;
    try{
      if(!await registerPhoneOnServer(phone))return;
      await request('/v1/pair/presence',{phone:phone,deviceId:getDeviceId()});
    }catch(error){
      registeredServerPhone='';
      if(error&&['device_not_owner','phone_not_registered'].includes(error.code)){
        if(typeof window.onayForceLogout==='function')window.onayForceLogout('Аккаунт басқа телефонда ашылды. Бұл телефоннан шығу орындалды.');
      }
    }
    finally{presenceInFlight=false;}
  }
  function releaseAccountPresence(){
    var phone=accountPhone();
    registeredServerPhone='';
    if(phone.length<10)return;
    request('/v1/account/logout',{phone:phone,deviceId:getDeviceId()}).catch(function(){});
  }
  function startApprovalPolling(){
    if(approvalPollTimer)return;
    approvalPollTimer=setInterval(pollPendingApproval,2500);
    presenceTimer=setInterval(heartbeatPresence,5000);
    pollPendingApproval();
    heartbeatPresence();
  }
  function openApproval(requestInfo){
    clearReceiverPolling();
    clearApprovalStatusPolling();
    currentApproval=requestInfo;
    mode='approval';
    $('pair-title').textContent='Жаңа телефон сұрауы';
    $('pair-text').textContent='Осы нөмірдің деректерін екінші телефонға көшіруге рұқсат бересіз бе? Екінші телефон кіргенде бұл телефон аккаунттан шығады.';
    hidePairParts();
    $('pair-approval-actions').hidden=false;
    $('pair-approve').onclick=approveCurrent;
    $('pair-reject').onclick=rejectCurrent;
    status('Екінші телефон осы нөмірді енгізді.');
    showModal();
  }
  async function rejectCurrent(){
    if(!currentApproval||approvalActionInFlight)return;
    approvalActionInFlight=true;
    setBusy(true);
    try{
      await request('/v1/pair/reject',{requestId:currentApproval.requestId,phone:accountPhone(),deviceId:getDeviceId()});
      status('Сұрау қабылданбады.');
      setTimeout(hideModal,500);
    }catch(error){status(error.message,true);setBusy(false);}
    finally{approvalActionInFlight=false;}
  }
  async function approveCurrent(){
    if(!currentApproval||approvalActionInFlight)return;
    approvalActionInFlight=true;
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
        deviceId:getDeviceId(),
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
      $('pair-text').textContent='Алыста болса 8 таңбалы кодты, жақын болса QR-ды екінші телефонмен қолданыңыз. Екінші телефон кіргенде бұл телефон автоматты түрде шығады.';
      status('Код 10 минут жарамды.');
      setBusy(false);
      clearApprovalStatusPolling();
      approvalStatusTimer=setInterval(pollApprovedStatus,2000);
    }catch(error){status(error.message||'Растау сәтсіз аяқталды.',true);setBusy(false);}
    finally{approvalActionInFlight=false;}
  }
  async function pollApprovedStatus(){
    if(!currentApproval)return;
    try{
      var result=await request('/v1/pair/status',{requestId:currentApproval.requestId});
      if(result.status==='claimed'){
        clearApprovalStatusPolling();
        if(typeof window.onayForceLogout==='function'){
          window.onayForceLogout('Екінші телефон кірді. Бұл телефон аккаунттан шығарылды. Кіру үшін жаңа растау қажет.');
        }else{
          status('Екінші телефон кірді. Бұл телефон аккаунттан шығарылады.');
        }
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
    if(pairRequestInFlight)return;
    if((mode==='requester'||mode==='receiver')&&normalizePhone(receiverPhone)===phone){
      showModal();
      return;
    }
    var saved=parse(sessionStorage.getItem(RECEIVER_STATE_KEY));
    if(saved&&saved.requestId&&normalizePhone(saved.phone)===phone){
      receiverPhone=phone;
      receiverRequestId=String(saved.requestId);
      showReceiverWaiting(saved);
      return;
    }
    var node=$('auth-error');
    if(node)node.textContent='';
    pairRequestInFlight=true;
    try{
      var result=await request('/v1/pair/request',{phone:phone,requesterDeviceId:getDeviceId()});
      receiverPhone=phone;
      receiverRequestId=result.requestId;
      saveReceiverState();
      showReceiverWaiting(result);
    }catch(error){
      if(error&&error.code==='owner_offline'){
        showRegisteredOffline(phone);
      }else{
        clearReceiverState();
        receiverRequestId='';
        receiverPhone='';
        if(node)node.textContent=error&&error.message
          ?error.message
          :'Серверге қосылу мүмкін болмады. Интернетті тексеріп, қайтадан «Жалғастыру» батырмасын басыңыз.';
      }
    }finally{
      pairRequestInFlight=false;
    }
  }
  window.onayPairingLogout=releaseAccountPresence;
  function showRegisteredOffline(phone){
    stopScanner();
    clearReceiverPolling();
    clearApprovalStatusPolling();
    mode='registered-offline';
    receiverPhone=phone;
    receiverRequestId='';
    clearReceiverState();
    $('pair-title').textContent='Нөмір тіркелген';
    $('pair-text').textContent='Бұл нөмір бұрын тіркелген. Бірінші телефон желіге қосылғанда қайта көріңіз.';
    hidePairParts();
    status('Нөмір тіркелген, бірақ иесі қазір желіде емес. Кейін қайталаңыз.',true);
    showModal();
  }

  function showReceiverWaiting(result){
    stopScanner();
    clearApprovalStatusPolling();
    clearReceiverPolling();
    mode='requester';
    $('pair-title').textContent='Бірінші телефонды растау';
    $('pair-text').textContent='Нөміріңіз бірінші телефонда онлайн болса, сол телефонда растау батырмасы шығады.';
    hidePairParts();
    status('Растауды күтіп тұр. Бірінші телефон растағаннан кейін код пен QR бөлімі ашылады.');
    showModal();
    var modal=$('pair-modal');if(modal)modal.setAttribute('aria-label','Код енгізу және QR сканерлеу беті');
    receiverPollTimer=setInterval(pollReceiverStatus,1800);
    pollReceiverStatus();
  }
  function showReceiverApproved(){
    stopScanner();
    clearReceiverPolling();
    mode='receiver';
    if(typeof window.openQrPairingPage==='function'&&$('page-qr')){
      var modal=$('pair-modal');
      if(modal){
        modal.hidden=true;
        modal.style.display='none';
        modal.style.visibility='hidden';
      }
      status('');
      setBusy(false);
      window.openQrPairingPage();
      return;
    }
    $('pair-title').textContent='Код немесе QR арқылы алу';
    $('pair-text').textContent='Бірінші телефон көрсеткен 8 таңбалы кодты енгізіңіз немесе QR-ды сканерлеңіз.';
    hidePairParts();
    var openCode=$('pair-open-code');
    if(openCode){
      openCode.hidden=false;
      openCode.textContent='QR сканерлеу немесе код енгізу';
      openCode.onclick=openReceiverCodeEntry;
    }
    status('Бірінші телефон растады. QR сканерлеу немесе код енгізу бөлімін ашыңыз.');
    showModal();
    var modal=$('pair-modal');if(modal)modal.setAttribute('aria-label','Код енгізу және QR сканерлеу беті');
    setTimeout(function(){if($('pair-input'))$('pair-input').focus();},60);
  }
  function openReceiverCodeEntry(){
    if(mode!=='receiver')return;
    if(typeof window.openQrPairingPage==='function'&&$('page-qr')){
      window.openQrPairingPage();
      return;
    }
    var openCode=$('pair-open-code');
    if(openCode)openCode.hidden=true;
    $('pair-input').hidden=false;
    $('pair-input').value='';
    $('pair-scan').hidden=false;
    $('pair-scan').onclick=scanQr;
    $('pair-submit').hidden=false;
    $('pair-submit').disabled=false;
    $('pair-submit').textContent='Деректерді алу';
    $('pair-submit').onclick=claimRequestedPair;
    status('QR сканерлеңіз немесе 8 таңбалы кодты енгізіңіз.');
    showModal();
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
  async function claimRequestedPair(codeOverride){
    if(!receiverRequestId){
      pairingStatus('Алдымен бірінші телефоннан QR немесе код сұрауын алыңыз.',true);
      return;
    }
    if(claimInFlight)return;
    var input=pairingPageOpen()?$('qr-manual-input'):$('pair-input');
    var code=String(codeOverride||input&&input.value||'').replace(/\D/g,'');
    if(!/^\d{8}$/.test(code)){
      pairingStatus('8 таңбалы кодты толық енгізіңіз.',true);
      if(input)input.focus();
      return;
    }
    claimInFlight=true;
    setBusy(true);
    pairingStatus('Деректер алынуда…');
    try{
      var result=await request('/v1/pair/claim-request',{requestId:receiverRequestId,code:code});
      var data=await decrypt(result.encryptedPayload,code);
      saveImportedData(data);
      clearReceiverState();
      if(pairingPageOpen()&&typeof window.closeQrPage==='function'){
        window.closeQrPage();
        if(typeof window.showToast==='function')window.showToast('Синхрондау аяқталды. Қосымша ашылады…');
      }else pairingStatus('Синхрондау аяқталды. Қосымша ашылады…');
      setTimeout(function(){location.reload();},700);
    }catch(error){
      pairingStatus(error.message||'Код жарамсыз немесе мерзімі өткен.',true);
      setBusy(false);
    }finally{
      claimInFlight=false;
    }
  }
  function patchAuthSubmitPhone(){
    if(typeof window.authSubmitPhone!=='function'||window.authSubmitPhone.__onayPairWrapper)return;
    var original=window.authSubmitPhone;
    var wrapper=function(){
      var callArgs=arguments;
      var input=$('auth-phone-input');
      var digits=normalizePhone(input&&input.value);
      if(digits.length<10||digits.length>15)return original.apply(this,callArgs);
      if((mode==='requester'||mode==='receiver')&&normalizePhone(receiverPhone)===digits){
        if(mode==='receiver'&&typeof window.openQrPairingPage==='function')window.openQrPairingPage();
        else showModal();
        return;
      }
      if(autoPairBusy)return;
      autoPairBusy=true;
      request('/v1/account/status',{phone:digits,deviceId:getDeviceId()}).then(function(result){
        if(!result||result.registered!==true)return original.apply(this,callArgs);
        var localAccount=localAccountForPhone(digits);
        // A reinstall creates a new device id and has no local account. The
        // server PIN restores the account and transfers ownership directly;
        // the old phone is not asked for confirmation.
        if(result.owner===true&&localAccount)return original.apply(this,callArgs);
        remoteLoginPhone=digits;
        if(typeof window.onayPrepareRemoteAccountLogin==='function')window.onayPrepareRemoteAccountLogin(digits);
      }.bind(this)).catch(function(){
        var error=$('auth-error');
        if(error)error.textContent='Серверге қосылу мүмкін болмады. Интернетті тексеріп, кейін қайталаңыз.';
      }.bind(this)).finally(function(){autoPairBusy=false;});
    };
    wrapper.__onayPairWrapper=true;
    window.authSubmitPhone=wrapper;
  }
  function patchAuthLogin(){
    if(typeof window.authLogin!=='function'||window.authLogin.__onayRemoteLoginWrapper)return;
    var original=window.authLogin;
    var wrapper=async function(){
      var phone=normalizePhone(remoteLoginPhone);
      if(phone.length<10)return original.apply(this,arguments);
      if(remoteLoginBusy)return;
      var input=$('auth-login-pin'),pin=String(input&&input.value||'');
      if(!/^\d{4}$/.test(pin)){
        if(typeof window.authSetError==='function')window.authSetError('4 таңбалы PIN-кодты енгізіңіз.');
        return;
      }
      remoteLoginBusy=true;
      try{
        var result=await request('/v1/account/login',{phone:phone,deviceId:getDeviceId(),pin:pin});
        if(!result.account)throw new Error('Аккаунт деректері табылмады.');
        var accounts=parse(localStorage.getItem(AUTH_STORE_KEY))||{};
        accounts[phone]=result.account;
        localStorage.setItem(AUTH_STORE_KEY,JSON.stringify(accounts));
        localStorage.setItem(AUTH_LAST_PHONE_KEY,phone);
        sessionStorage.setItem(AUTH_PENDING_PHONE_KEY,phone);
        if(result.ledger)localStorage.setItem(ledgerKeyFor(phone),JSON.stringify(result.ledger));
        if(Array.isArray(result.favorites))localStorage.setItem(FAVORITES_KEY,JSON.stringify(result.favorites));
        remoteLoginPhone='';registeredServerPhone='';
        if(typeof window.authCompleteLogin==='function')window.authCompleteLogin(result.account);
      }catch(error){
        if(typeof window.authSetError==='function')window.authSetError(error.message||'Аккаунтты қалпына келтіру мүмкін болмады.');
        if(typeof window.authRenderPinDots==='function')window.authRenderPinDots(true);
      }finally{remoteLoginBusy=false;}
    };
    wrapper.__onayRemoteLoginWrapper=true;
    window.authLogin=wrapper;
  }
  function patchAuthFinishRegistration(){
    if(typeof window.authFinishRegistration!=='function'||window.authFinishRegistration.__onayPairRegistrationWrapper)return;
    var original=window.authFinishRegistration;
    var wrapper=function(){
      var result=original.apply(this,arguments);
      Promise.resolve(result).then(function(){
        var phone=normalizePhone(sessionStorage.getItem(AUTH_PENDING_PHONE_KEY));
        if(phone.length>=10)registerPhoneOnServer(phone);
      });
      return result;
    };
    wrapper.__onayPairRegistrationWrapper=true;
    window.authFinishRegistration=wrapper;
  }
  function watchAuthFlow(){
    var authContent=$('auth-content');
    if(authContent&&!authContent.__onayPairObserver){
      var observer=new MutationObserver(function(){patchAuthSubmitPhone();patchAuthLogin();patchAuthFinishRegistration();resumeReceiverRequest();});
      observer.observe(authContent,{childList:true,subtree:true});
      authContent.__onayPairObserver=true;
    }
    patchAuthSubmitPhone();
    patchAuthLogin();
    patchAuthFinishRegistration();
    resumeReceiverRequest();
  }
  function install(){
    if(!$('pair-modal')){
      var style=document.createElement('style');
      style.textContent='.pair-auth-action{display:block;width:100%;min-height:44px;margin:10px 0 0;border:1px solid #e4b400;border-radius:999px;background:#fff7d6;color:#11152d;font-size:13px;font-weight:700}.pair-auth-action:disabled{opacity:.55}.pair-auth-note{margin:8px 0 0;color:#737887;font-size:11px;line-height:1.4;text-align:center}.pair-modal{position:absolute;inset:0;z-index:2000;display:flex;align-items:flex-end;justify-content:center;padding:12px;background:rgba(18,20,28,.38)}.pair-modal[hidden]{display:none!important}.pair-dialog{width:min(100%,420px);padding:22px 18px calc(18px + env(safe-area-inset-bottom));border-radius:24px;background:#fff;box-shadow:0 16px 50px rgba(0,0,0,.22)}.pair-dialog h3{margin:0 0 8px;color:#11152d;font-size:17px}.pair-dialog p{margin:0 0 12px;color:#626675;font-size:12px;line-height:1.45}.pair-close{float:right;width:30px;height:30px;border:0;border-radius:50%;background:#f0f1f7;font-size:20px}.pair-code{margin:16px 0 12px;padding:12px;border-radius:14px;background:#fff7d6;color:#171717;font-size:30px;font-weight:800;letter-spacing:4px;text-align:center}.pair-input{box-sizing:border-box;width:100%;height:48px;margin:8px 0 12px;border:1px solid #d9dce7;border-radius:13px;font-size:22px;letter-spacing:5px;text-align:center}.pair-submit{width:100%;height:46px;border:0;border-radius:999px;background:#ffbf00;font-size:13px;font-weight:700}.pair-submit:disabled{opacity:.55}.pair-open-code{display:block;width:100%;height:42px;margin:8px 0 10px;border:0;border-radius:12px;background:#fff7d6;color:#6a5200;font-size:12px;font-weight:700;text-decoration:underline}.pair-qr{display:block;width:220px;height:220px;margin:12px auto;border-radius:12px;background:#fff}.pair-scan{width:100%;height:42px;margin:0 0 10px;border:1px solid #d9dce7;border-radius:12px;background:#f7f8fc;color:#11152d;font-size:12px;font-weight:700}.pair-scanner-video{display:block;width:100%;max-height:220px;margin:8px 0;border-radius:14px;background:#10131c;object-fit:cover}.pair-approval-actions{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin:12px 0}.pair-approval-actions button{height:44px;border:0;border-radius:999px;font-size:13px;font-weight:700}.pair-approve{background:#ffbf00;color:#11152d}.pair-reject{background:#f0f1f7;color:#11152d}.pair-status{min-height:18px;text-align:center}';
      document.head.appendChild(style);
      var root=$('onay-app-root')||document.body;
      root.insertAdjacentHTML('beforeend','<div class="pair-modal" hidden id="pair-modal" onclick="if(event.target===this)closeDevicePairModal()"><div class="pair-dialog" role="dialog" aria-modal="true"><button class="pair-close" type="button" onclick="closeDevicePairModal()">×</button><h3 id="pair-title">Телефонды синхрондау</h3><p id="pair-text"></p><div class="pair-approval-actions" hidden id="pair-approval-actions"><button class="pair-approve" id="pair-approve" type="button">Растау</button><button class="pair-reject" id="pair-reject" type="button">Бас тарту</button></div><div class="pair-code" hidden id="pair-code"></div><img class="pair-qr" hidden id="pair-qr" alt="ONAY синхрондау QR коды"/><video class="pair-scanner-video" hidden id="pair-scanner-video" playsinline muted></video><button class="pair-open-code" hidden id="pair-open-code" type="button">QR сканерлеу немесе код енгізу</button><input class="pair-input" hidden id="pair-input" maxlength="8" inputmode="numeric" type="tel" placeholder="00000000"/><button class="pair-scan" hidden id="pair-scan" type="button">QR сканерін ашу</button><button class="pair-submit" hidden id="pair-submit" type="button">Деректерді алу</button><p class="pair-status" id="pair-status" aria-live="polite"></p></div></div>');
    }
    watchAuthFlow();
    if(!window.authSubmitPhone||!window.authSubmitPhone.__onayPairWrapper||!window.authLogin||!window.authLogin.__onayRemoteLoginWrapper||!window.authFinishRegistration||!window.authFinishRegistration.__onayPairRegistrationWrapper){
      var retries=0;
      authHookRetryTimer=setInterval(function(){
        watchAuthFlow();
        retries++;
        if((window.authSubmitPhone&&window.authSubmitPhone.__onayPairWrapper&&window.authLogin&&window.authLogin.__onayRemoteLoginWrapper&&window.authFinishRegistration&&window.authFinishRegistration.__onayPairRegistrationWrapper)||retries>=40){
          clearInterval(authHookRetryTimer);
          authHookRetryTimer=null;
        }
      },250);
    }
    startApprovalPolling();
  }
  window.closeDevicePairModal=hideModal;
  if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',install);else install();
})();
