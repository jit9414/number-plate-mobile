'use strict';

const BACKUP_NAME = 'shri-ganesh-motors-number-plate-cloud-backup.sgmcloud';
const DRIVE_API = 'https://www.googleapis.com/drive/v3';
const DRIVE_UPLOAD = 'https://www.googleapis.com/upload/drive/v3';
const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.appdata https://www.googleapis.com/auth/userinfo.email';
const KDF_ROUNDS = 310000;
const STORAGE_KEY = 'sgm.number-plate.mobile.v1';
const $ = selector => document.querySelector(selector);
const escapeHtml = value => String(value ?? '').replace(/[&<>"']/g, ch => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[ch]));
const dateLabel = value => { const m=String(value||'').match(/^(\d{4})-(\d{2})-(\d{2})/);return m?`${m[3]}/${m[2]}/${m[1]}`:'—'; };
const todayISO = () => { const d=new Date();return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-${String(d.getDate()).padStart(2,'0')}`; };
let saved = {};
try { saved = JSON.parse(localStorage.getItem(STORAGE_KEY)||'{}'); } catch { localStorage.removeItem(STORAGE_KEY); }
const state = { clientId:saved.clientId||'', email:saved.email||'', orders:Array.isArray(saved.orders)?saved.orders:[], remoteFileId:saved.remoteFileId||'', remoteModifiedAt:saved.remoteModifiedAt||'', pendingOps:Array.isArray(saved.pendingOps)?saved.pendingOps:[], token:'', tokenExpiresAt:0, backupPassword:'', googleClient:null, conflictSnapshot:null, deferredInstall:null, toastTimer:0 };

function persist() {
  localStorage.setItem(STORAGE_KEY,JSON.stringify({clientId:state.clientId,email:state.email,orders:state.orders,remoteFileId:state.remoteFileId,remoteModifiedAt:state.remoteModifiedAt,pendingOps:state.pendingOps}));
}
function notify(message,type='') { const el=$('#toast');el.textContent=message;el.className=`toast ${type}`;clearTimeout(state.toastTimer);state.toastTimer=setTimeout(()=>el.classList.add('hidden'),4200); }
function setNotice(message,type='') { const node=$('#syncNotice');if(!message){node.className='notice hidden';node.replaceChildren();return;}node.className=`notice ${type}`;node.textContent=message; }
function setBadge(mode,label) { const el=$('#syncBadge');el.className=`sync-badge ${mode||''}`;el.querySelector('span').textContent=label; }
function showModal(id) { $(`#${id}`).classList.remove('hidden');document.body.classList.add('modal-open'); }
function hideModal(id) { $(`#${id}`).classList.add('hidden');if(!document.querySelector('.modal-backdrop:not(.hidden)'))document.body.classList.remove('modal-open'); }
function updateSummary() {
  $('#totalCount').textContent=state.orders.length.toLocaleString();
  $('#dealerPending').textContent=state.orders.filter(o=>o.dealerReceived!=='Yes').length.toLocaleString();
  $('#customerPending').textContent=state.orders.filter(o=>o.customerReceived!=='Yes').length.toLocaleString();
}
function renderOrders() {
  const query=$('#searchInput').value.trim().toLowerCase();
  const rows=state.orders.filter(o=>!query||[o.customerName,o.registrationNo,o.frameNo,o.engineNo,o.remark].join(' ').toLowerCase().includes(query));
  $('#resultCount').textContent=`${rows.length.toLocaleString()} record${rows.length===1?'':'s'}`;
  $('#emptyState').classList.toggle('hidden',rows.length>0);
  $('#ordersList').innerHTML=rows.map(o=>`<article class="order-card" data-id="${escapeHtml(o.id)}"><div class="card-top"><div><h3>${escapeHtml(o.customerName)}</h3><div class="reg-no">${escapeHtml(o.registrationNo)}</div></div><span class="plate-state ${o.dealerReceived==='Yes'?'':'pending'}">${o.dealerReceived==='Yes'?'Dealer received':'Dealer pending'}</span></div><div class="card-details"><span><b>Frame No.</b>${escapeHtml(o.frameNo)}</span><span><b>Engine No.</b>${escapeHtml(o.engineNo)}</span><span><b>Registration date</b>${dateLabel(o.registrationDate)}</span><span><b>Received date</b>${dateLabel(o.receivedDate)}</span></div><div class="card-footer"><div class="statuses"><span class="status-chip ${o.dealerReceived==='Yes'?'yes':''}">Dealer ${o.dealerReceived==='Yes'?'Yes':'Pending'}</span><span class="status-chip ${o.customerReceived==='Yes'?'yes':''}">Customer ${o.customerReceived==='Yes'?'Yes':'Pending'}</span></div><div class="card-actions"><button data-action="edit">Edit</button><button class="delete-order" data-action="delete">Delete</button></div></div></article>`).join('');
  updateSummary();
}
function fillOrderForm(order={}) {
  $('#orderId').value=order.id||'';
  $('#customerName').value=order.customerName||'';
  $('#registrationNo').value=order.registrationNo||'';
  $('#frameNo').value=order.frameNo||'';
  $('#engineNo').value=order.engineNo||'';
  $('#registrationDate').value=order.registrationDate||'';
  $('#dealerReceived').value=order.dealerReceived||'No';
  $('#customerReceived').value=order.customerReceived||'No';
  $('#receivedDate').value=order.receivedDate||'';
  $('#remark').value=order.remark||'';
  $('#orderTitle').textContent=order.id?'Edit number plate order':'New number plate order';
  showModal('orderModal');setTimeout(()=>$('#customerName').focus(),100);
}
function readOrder() {
  return { id:$('#orderId').value||crypto.randomUUID(),entryDate:todayISO(),registrationNo:$('#registrationNo').value.trim().toUpperCase(),frameNo:$('#frameNo').value.trim().toUpperCase(),engineNo:$('#engineNo').value.trim().toUpperCase(),registrationDate:$('#registrationDate').value,customerName:$('#customerName').value.trim(),dealerReceived:$('#dealerReceived').value,customerReceived:$('#customerReceived').value,receivedDate:$('#receivedDate').value,remark:$('#remark').value.trim(),createdAt:new Date().toISOString(),updatedAt:new Date().toISOString()};
}

function bytesToBase64(bytes) { let binary='';for(const b of bytes)binary+=String.fromCharCode(b);return btoa(binary); }
function base64ToBytes(value) { const binary=atob(value);return Uint8Array.from(binary,ch=>ch.charCodeAt(0)); }
async function deriveKey(password,salt,rounds=KDF_ROUNDS) {
  const material=await crypto.subtle.importKey('raw',new TextEncoder().encode(password),'PBKDF2',false,['deriveKey']);
  return crypto.subtle.deriveKey({name:'PBKDF2',salt,iterations:rounds,hash:'SHA-256'},material,{name:'AES-GCM',length:256},false,['encrypt','decrypt']);
}
async function encryptSnapshot(snapshot) {
  const salt=crypto.getRandomValues(new Uint8Array(16)),iv=crypto.getRandomValues(new Uint8Array(12));
  const key=await deriveKey(state.backupPassword,salt);
  const combined=new Uint8Array(await crypto.subtle.encrypt({name:'AES-GCM',iv,tagLength:128},key,new TextEncoder().encode(JSON.stringify(snapshot))));
  const tag=combined.slice(-16),cipher=combined.slice(0,-16),rounds=new Uint8Array([KDF_ROUNDS>>>16&255,KDF_ROUNDS>>>8&255,KDF_ROUNDS&255]);
  const magic=new TextEncoder().encode('SGMPLT2');
  const output=new Uint8Array(magic.length+salt.length+iv.length+rounds.length+tag.length+cipher.length);let offset=0;
  for(const part of [magic,salt,iv,rounds,tag,cipher]){output.set(part,offset);offset+=part.length;}
  return output;
}
async function decryptSnapshot(encrypted) {
  const magic=new TextDecoder().decode(encrypted.slice(0,7));
  if(magic==='SGMPLT1')throw new Error('This cloud file is in the old desktop-only format. Open Number Plate Manager 1.0.8 once while online; it will safely upgrade the cloud copy for mobile use.');
  if(magic!=='SGMPLT2'||encrypted.length<54)throw new Error('This is not a supported Number Plate cloud backup.');
  const salt=encrypted.slice(7,23),iv=encrypted.slice(23,35),rounds=encrypted[35]<<16|encrypted[36]<<8|encrypted[37];
  if(rounds<100000||rounds>1000000)throw new Error('Cloud backup encryption settings are not valid.');
  const key=await deriveKey(state.backupPassword,salt,rounds),cipherAndTag=new Uint8Array(encrypted.length-54);
  cipherAndTag.set(encrypted.slice(54),0);cipherAndTag.set(encrypted.slice(38,54),cipherAndTag.length-16);
  let snapshot;
  try { snapshot=JSON.parse(new TextDecoder().decode(await crypto.subtle.decrypt({name:'AES-GCM',iv,tagLength:128},key,cipherAndTag))); }
  catch { throw new Error('Backup password is incorrect or the cloud file is damaged.'); }
  if(snapshot?.format!=='SGM-NUMBER-PLATE'||snapshot.version!==2||!Array.isArray(snapshot.orders))throw new Error('Cloud data format is not compatible.');
  return snapshot;
}

function requestAccessToken() {
  if(!window.google?.accounts?.oauth2)throw new Error('Google sign-in is still loading. Wait a moment, then tap again.');
  if(!state.clientId.endsWith('.apps.googleusercontent.com'))throw new Error('Enter the Google OAuth Web Client ID first.');
  return new Promise((resolve,reject)=>{
    state.googleClient=google.accounts.oauth2.initTokenClient({client_id:state.clientId,scope:DRIVE_SCOPE,callback:response=>{
      if(response.error||!response.access_token){reject(new Error(response.error_description||response.error||'Google sign-in was not completed.'));return;}
      state.token=response.access_token;state.tokenExpiresAt=Date.now()+Math.max(0,Number(response.expires_in||3600)-60)*1000;resolve(response.access_token);
    }});
    state.googleClient.requestAccessToken({prompt:''});
  });
}
async function apiFetch(url,options={}) {
  if(!state.token||Date.now()>=state.tokenExpiresAt)throw new Error('Google access expired. Tap Sync and sign in again to continue.');
  const response=await fetch(url,{...options,headers:{...(options.headers||{}),Authorization:`Bearer ${state.token}`}});
  if(!response.ok){let message=`Google Drive request failed (${response.status}).`;try{const data=await response.json();message=data.error?.message||message;}catch{}if(response.status===401){state.token='';state.tokenExpiresAt=0;}throw new Error(message);}
  return response;
}
async function getEmail() {
  const response=await apiFetch('https://www.googleapis.com/oauth2/v2/userinfo');
  return (await response.json()).email||'';
}
async function findCloudFile() {
  const q=encodeURIComponent(`name='${BACKUP_NAME}' and 'appDataFolder' in parents and trashed=false`);
  const response=await apiFetch(`${DRIVE_API}/files?q=${q}&spaces=appDataFolder&fields=files(id,name,modifiedTime,size)&pageSize=10&orderBy=modifiedTime%20desc`);
  return (await response.json()).files?.[0]||null;
}
async function downloadCloudFile(file) {
  const response=await apiFetch(`${DRIVE_API}/files/${encodeURIComponent(file.id)}?alt=media`);
  const encrypted=new Uint8Array(await response.arrayBuffer());
  const snapshot=await decryptSnapshot(encrypted);
  return {file,snapshot};
}
function normalizeCloudOrder(order) {
  return {id:String(order.id||crypto.randomUUID()),entryDate:String(order.entryDate||''),registrationNo:String(order.registrationNo||''),frameNo:String(order.frameNo||''),engineNo:String(order.engineNo||''),registrationDate:String(order.registrationDate||''),customerName:String(order.customerName||''),dealerReceived:order.dealerReceived==='Yes'?'Yes':'No',customerReceived:order.customerReceived==='Yes'?'Yes':'No',receivedDate:String(order.receivedDate||''),remark:String(order.remark||''),createdAt:String(order.createdAt||new Date().toISOString()),updatedAt:String(order.updatedAt||order.createdAt||new Date().toISOString())};
}
async function uploadSnapshot(orders,file) {
  const snapshot={format:'SGM-NUMBER-PLATE',version:2,updatedAt:new Date().toISOString(),orders:orders.map(normalizeCloudOrder)};
  const encrypted=await encryptSnapshot(snapshot),boundary=`sgm_mobile_${crypto.randomUUID().replaceAll('-','')}`;
  const metadata=file?{name:BACKUP_NAME}:{name:BACKUP_NAME,parents:['appDataFolder']};
  const encoder=new TextEncoder();
  const head=encoder.encode(`--${boundary}\r\nContent-Type: application/json; charset=UTF-8\r\n\r\n${JSON.stringify(metadata)}\r\n--${boundary}\r\nContent-Type: application/octet-stream\r\n\r\n`);
  const tail=encoder.encode(`\r\n--${boundary}--`),body=new Blob([head,encrypted,tail]);
  const url=file?`${DRIVE_UPLOAD}/files/${encodeURIComponent(file.id)}?uploadType=multipart`:`${DRIVE_UPLOAD}/files?uploadType=multipart`;
  await apiFetch(url,{method:file?'PATCH':'POST',headers:{'Content-Type':`multipart/related; boundary=${boundary}`},body});
  return findCloudFile();
}
function setCloudSnapshot(file,snapshot) {
  state.remoteFileId=file.id;state.remoteModifiedAt=file.modifiedTime||'';state.orders=snapshot.orders.map(normalizeCloudOrder);persist();renderOrders();
  setBadge('online',state.pendingOps.length?'Pending changes':'Cloud connected');
}
async function loadLatestCloud({preservePending=false}={}) {
  const file=await findCloudFile();
  if(!file)return null;
  const result=await downloadCloudFile(file);
  if(preservePending)state.conflictSnapshot=result;
  else setCloudSnapshot(result.file,result.snapshot);
  return result;
}
function applyOperations(base,operations) {
  let rows=base.map(normalizeCloudOrder);
  for(const op of operations){
    if(op.type==='delete')rows=rows.filter(row=>row.id!==op.id);
    else if(op.type==='upsert'){const index=rows.findIndex(row=>row.id===op.order.id);if(index<0)rows.push(normalizeCloudOrder(op.order));else rows[index]=normalizeCloudOrder(op.order);}
  }
  return rows;
}
function showConflict(result) {
  state.conflictSnapshot=result;
  state.orders=result.snapshot.orders.map(normalizeCloudOrder);
  state.remoteFileId=result.file.id;state.remoteModifiedAt=result.file.modifiedTime||'';persist();renderOrders();
  const notice=$('#syncNotice');notice.className='notice';
  notice.innerHTML=`Cloud data changed on another device. This phone's ${state.pendingOps.length} unsynced change(s) are preserved. <div class="conflict-actions"><button data-conflict="cloud" class="secondary-button">Use cloud copy</button><button data-conflict="phone" class="primary-button">Apply phone changes</button></div>`;
  setBadge('pending','Sync needs choice');
}
async function checkRemoteConflict() {
  const remote=await findCloudFile();
  if(!remote)throw new Error('The shared cloud backup was not found. Open the desktop app online first to create it.');
  if(!state.remoteFileId){const result=await downloadCloudFile(remote);setCloudSnapshot(result.file,result.snapshot);return true;}
  if(remote.id!==state.remoteFileId||remote.modifiedTime!==state.remoteModifiedAt){
    const result=await downloadCloudFile(remote);
    if(state.pendingOps.length){showConflict(result);return true;}
    setCloudSnapshot(result.file,result.snapshot);
    setNotice('Latest changes from another device were loaded.','success');
    return true;
  }
  return false;
}
async function pushPendingChanges() {
  if(!state.pendingOps.length)return;
  if(!navigator.onLine) {setBadge('pending','Saved on phone');setNotice('Saved on this phone. Connect to the internet and tap Sync to upload changes.');return;}
  if(!state.token||Date.now()>=state.tokenExpiresAt){setBadge('pending','Sign in to sync');setNotice('Your edits are saved on this phone. Tap Sync and sign in again to upload them.');return;}
  const changed=await checkRemoteConflict();
  if(changed&&state.conflictSnapshot)return;
  const file=await findCloudFile();
  const next=applyOperations(state.orders,state.pendingOps);
  const updatedFile=await uploadSnapshot(next,file);
  if(!updatedFile)throw new Error('The encrypted backup upload finished, but Drive did not return its file. Tap Sync to check again.');
  state.orders=next;state.pendingOps=[];state.remoteFileId=updatedFile.id;state.remoteModifiedAt=updatedFile.modifiedTime||'';state.conflictSnapshot=null;persist();renderOrders();
  setBadge('online','Cloud synced');setNotice('Encrypted changes saved to Google Drive.','success');
}
async function resolveConflict(choice) {
  const conflict=state.conflictSnapshot;if(!conflict)return;
  if(choice==='cloud'){
    state.orders=conflict.snapshot.orders.map(normalizeCloudOrder);state.pendingOps=[];state.remoteFileId=conflict.file.id;state.remoteModifiedAt=conflict.file.modifiedTime||'';state.conflictSnapshot=null;persist();renderOrders();setNotice('Cloud copy selected. This phone’s unsynced changes were discarded.','success');setBadge('online','Cloud connected');return;
  }
  try {
    $('#refreshButton').disabled=true;
    const latest=await findCloudFile();
    if(latest.modifiedTime!==conflict.file.modifiedTime){const next=await downloadCloudFile(latest);showConflict(next);notify('Cloud changed again. Review the latest conflict first.','error');return;}
    const merged=applyOperations(conflict.snapshot.orders,state.pendingOps);
    const updated=await uploadSnapshot(merged,latest);
    state.orders=merged;state.pendingOps=[];state.remoteFileId=updated.id;state.remoteModifiedAt=updated.modifiedTime||'';state.conflictSnapshot=null;persist();renderOrders();setNotice('Phone changes were applied over the latest cloud copy.','success');setBadge('online','Cloud synced');
  } catch(error){notify(error.message||'Could not resolve the sync conflict.','error');}
  finally{$('#refreshButton').disabled=false;}
}
async function connectAndSync() {
  const button=$('#connectButton');
  const id=$('#webClientId').value.trim(),password=$('#backupPassword').value;
  if(!id.endsWith('.apps.googleusercontent.com')){notify('Enter a valid OAuth Web Client ID.','error');$('#webClientId').focus();return;}
  if(password.length<8){notify('Enter the same cloud backup password (at least 8 characters).','error');$('#backupPassword').focus();return;}
  state.clientId=id;state.backupPassword=password;persist();button.disabled=true;button.textContent='Opening Google sign-in…';
  try {
    await requestAccessToken();
    const email=await getEmail();
    if(state.email&&state.email.toLowerCase()!==email.toLowerCase())throw new Error(`This phone is set up for ${state.email}. Sign in with that same Google account.`);
    const previousCloudVersion=state.remoteModifiedAt;
    state.email=email;persist();
    const result=await loadLatestCloud();
    if(!result)throw new Error('No shared Number Plate cloud file was found. Install/open the updated desktop app online once; it will create the mobile-compatible encrypted backup.');
    hideModal('settingsModal');$('#accountLine').textContent=`Connected as ${email}`;$('#forgetThisDevice').classList.remove('hidden');setNotice('Latest encrypted cloud data loaded. This phone is ready to use.','success');
    if(state.pendingOps.length){const remoteChanged=Boolean(previousCloudVersion&&result.file.modifiedTime!==previousCloudVersion);if(remoteChanged){showConflict(result);}else await pushPendingChanges();}
    else {setBadge('online','Cloud connected');}
    startPolling();
  } catch(error){notify(error.message||'Could not connect Google Drive.','error');setBadge('','Connection needed');}
  finally{button.disabled=false;button.textContent='Continue with Google';}
}
async function syncNow() {
  const button=$('#refreshButton');button.disabled=true;button.textContent='Syncing…';
  try {
    if(!state.token||Date.now()>=state.tokenExpiresAt){await requestAccessToken();const email=await getEmail();if(state.email&&email.toLowerCase()!==state.email.toLowerCase())throw new Error(`Sign in with the saved account ${state.email}.`);state.email=email;}
    if(!state.backupPassword){showModal('settingsModal');$('#webClientId').value=state.clientId;$('#accountLine').textContent=state.email?`Saved account: ${state.email}`:'Not connected';notify('Enter your cloud backup password to decrypt the shared data.','error');return;}
    if(!state.remoteFileId){const result=await loadLatestCloud();if(!result)throw new Error('No shared cloud backup found. Open the desktop app online once.');}
    else await checkRemoteConflict();
    if(state.pendingOps.length&&!state.conflictSnapshot)await pushPendingChanges();
    else if(!state.pendingOps.length){setBadge('online','Cloud synced');setNotice('Latest cloud data is loaded.','success');}
    startPolling();
  } catch(error){notify(error.message||'Cloud sync failed.','error');if(/expired|sign in/i.test(error.message))setBadge('pending','Sign in to sync');}
  finally{button.disabled=false;button.textContent='↻ Sync';}
}
function startPolling() {
  clearInterval(state.pollTimer);
  state.pollTimer=setInterval(async()=>{
    if(!state.token||Date.now()>=state.tokenExpiresAt||!state.backupPassword||state.conflictSnapshot||state.pendingOps.length||!navigator.onLine||!$('#orderModal').classList.contains('hidden'))return;
    try{await checkRemoteConflict();}catch(error){if(/expired|sign in/i.test(error.message)){setBadge('pending','Tap Sync to sign in');return;}console.warn('Mobile cloud refresh failed:',error);}
  },15000);
}
async function saveOrder(event) {
  event.preventDefault();
  const row=readOrder(),existing=state.orders.find(o=>o.id===row.id);
  if(existing){row.entryDate=existing.entryDate||row.entryDate;row.createdAt=existing.createdAt||row.createdAt;}
  const operation={type:'upsert',order:row};
  try {
    if(navigator.onLine&&state.token&&Date.now()<state.tokenExpiresAt){
      const changed=await checkRemoteConflict();
      if(changed){notify('Latest cloud data was refreshed. Review it, then reopen this order before saving.','error');return;}
    }
    if(existing){state.orders=state.orders.map(o=>o.id===row.id?row:o);}else state.orders.unshift(row);
    state.pendingOps.push(operation);persist();renderOrders();hideModal('orderModal');setNotice('Saved on this phone.','');
    if(navigator.onLine&&state.token&&Date.now()<state.tokenExpiresAt)await pushPendingChanges();else{setBadge('pending','Saved on phone');setNotice('Saved on this phone. Tap Sync when connected to upload.');}
  }catch(error){notify(error.message||'Could not save the order.','error');}
}
async function deleteOrder(id) {
  const row=state.orders.find(o=>o.id===id);if(!row)return;
  if(!confirm(`Delete ${row.registrationNo} for ${row.customerName}?`))return;
  try {
    if(navigator.onLine&&state.token&&Date.now()<state.tokenExpiresAt){const changed=await checkRemoteConflict();if(changed){notify('Latest cloud data was refreshed. Review the order before deleting.','error');return;}}
    state.orders=state.orders.filter(o=>o.id!==id);state.pendingOps.push({type:'delete',id});persist();renderOrders();
    if(navigator.onLine&&state.token&&Date.now()<state.tokenExpiresAt)await pushPendingChanges();else{setBadge('pending','Saved on phone');setNotice('Delete saved on this phone. Tap Sync when connected to upload.');}
  }catch(error){notify(error.message||'Could not delete the order.','error');}
}
function disconnectPhone() {
  state.token='';state.tokenExpiresAt=0;state.backupPassword='';clearInterval(state.pollTimer);$('#backupPassword').value='';$('#accountLine').textContent='Not connected';hideModal('settingsModal');setBadge('','Offline cache');setNotice('This phone was disconnected from Google. Its local copy and any unsynced edits remain on this phone.');
}
function wireConflictButtons(event) { const button=event.target.closest('[data-conflict]');if(button)resolveConflict(button.dataset.conflict); }
function installPrompt(event){event.preventDefault();state.deferredInstall=event;$('#installButton').classList.remove('hidden');}
async function installApp(){if(!state.deferredInstall)return;state.deferredInstall.prompt();await state.deferredInstall.userChoice;state.deferredInstall=null;$('#installButton').classList.add('hidden');}

document.addEventListener('DOMContentLoaded',()=>{
  $('#webClientId').value=state.clientId;
  $('#accountLine').textContent=state.email?`Saved Google account: ${state.email}`:'Not connected';
  $('#forgetThisDevice').classList.toggle('hidden',!state.email);
  renderOrders();
  if(state.orders.length){setBadge(state.pendingOps.length?'pending':'','Saved on this phone');setNotice(state.pendingOps.length?'This phone has unsynced edits. Tap Sync when online.':'Showing the saved phone cache. Connect and sync to check for newer cloud data.');}
  if(!state.clientId||!state.orders.length)showModal('settingsModal');
  $('#settingsButton').addEventListener('click',()=>showModal('settingsModal'));
  $('.close-settings').addEventListener('click',()=>hideModal('settingsModal'));
  $('#connectButton').addEventListener('click',connectAndSync);
  $('#forgetThisDevice').addEventListener('click',disconnectPhone);
  $('#newOrderButton').addEventListener('click',()=>{if(!state.orders.length&&!state.remoteFileId){notify('Connect and load the shared desktop data first.','error');showModal('settingsModal');return;}fillOrderForm();});
  $('#closeOrder').addEventListener('click',()=>hideModal('orderModal'));
  $('#cancelOrder').addEventListener('click',()=>hideModal('orderModal'));
  $('#orderForm').addEventListener('submit',saveOrder);
  $('#ordersList').addEventListener('click',event=>{const button=event.target.closest('[data-action]');if(!button)return;const id=button.closest('.order-card').dataset.id;const row=state.orders.find(o=>o.id===id);if(button.dataset.action==='edit')fillOrderForm(row);if(button.dataset.action==='delete')deleteOrder(id);});
  $('#searchInput').addEventListener('input',renderOrders);
  $('#refreshButton').addEventListener('click',syncNow);
  $('#syncNotice').addEventListener('click',wireConflictButtons);
  $('#installButton').addEventListener('click',installApp);
  $('#settingsModal').addEventListener('click',event=>{if(event.target.id==='settingsModal')hideModal('settingsModal');});
  $('#orderModal').addEventListener('click',event=>{if(event.target.id==='orderModal')hideModal('orderModal');});
  window.addEventListener('online',()=>{if(state.pendingOps.length){setBadge('pending','Tap Sync to upload');setNotice('Internet is back. Tap Sync to upload this phone’s saved changes.');}else setBadge('','Tap Sync to check');});
  window.addEventListener('offline',()=>setBadge('pending','Offline · saved here'));
  window.addEventListener('beforeinstallprompt',installPrompt);
  if('serviceWorker' in navigator)navigator.serviceWorker.register('./sw.js').catch(error=>console.warn('PWA offline cache unavailable:',error));
});
